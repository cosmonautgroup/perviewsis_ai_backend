type SendVerificationInput = {
  to: string;
  name?: string;
  verificationUrl: string;
  appUrl?: string;
};

type EmailSender = {
  sendMail: (mail: { from: string; to: string; subject: string; text: string; html: string }) => Promise<void>;
};

let senderPromise: Promise<EmailSender | null> | null = null;

function resolveGraphSenderAddress() {
  return process.env.GRAPH_SENDER_EMAIL || process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER;
}

function extractEmailAddress(input?: string) {
  const value = String(input ?? "").trim();
  if (!value) return "";
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] || value).trim();
}

async function createGraphSender(): Promise<EmailSender | null> {
  const tenantId = process.env.TENANT_ID || process.env.GRAPH_TENANT_ID;
  const clientId = process.env.CLIENT_ID || process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET || process.env.GRAPH_CLIENT_SECRET;
  const senderEmail = extractEmailAddress(resolveGraphSenderAddress());
  if (!tenantId || !clientId || !clientSecret || !senderEmail) return null;

  const { ClientSecretCredential } = await import("@azure/identity");
  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
  return {
    async sendMail(mail) {
      const token = await credential.getToken("https://graph.microsoft.com/.default");
      if (!token?.token) throw new Error("Failed to acquire Microsoft Graph access token.");

      const response = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderEmail)}/sendMail`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              subject: mail.subject,
              body: {
                contentType: "HTML",
                content: mail.html,
              },
              toRecipients: [{ emailAddress: { address: mail.to } }],
            },
            saveToSentItems: true,
          }),
        },
      );

      if (response.status !== 202) {
        const errorText = await response.text();
        throw new Error(`Microsoft Graph sendMail failed (${response.status}): ${errorText}`);
      }
    },
  };
}

async function createSmtpSender(): Promise<EmailSender | null> {
  const host = process.env.SMTP_HOST;
  const portRaw = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = String(process.env.SMTP_SECURE ?? "").toLowerCase() === "true" || portRaw === 465;
  if (!host || !user || !pass || !Number.isFinite(portRaw)) return null;
  const nodemailerModule = await import("nodemailer");
  const nodemailer = (nodemailerModule as any)?.default ?? (nodemailerModule as any);
  if (!nodemailer?.createTransport) return null;
  const transporter = nodemailer.createTransport({
    host,
    port: portRaw,
    secure,
    auth: { user, pass },
  });
  return {
    async sendMail(mail) {
      await transporter.sendMail(mail);
    },
  };
}

async function getSender() {
  if (senderPromise) return senderPromise;
  senderPromise = (async () => {
    const graphSender = await createGraphSender();
    if (graphSender) return graphSender;
    return createSmtpSender();
  })();
  return senderPromise;
}

export async function sendVerificationEmail(input: SendVerificationInput): Promise<{ sent: boolean }> {
  try {
    const from = resolveGraphSenderAddress();
    const sender = await getSender();
    if (!from || !sender) {
      const hint = "[email-verification] Email provider not configured. Set Graph env vars (TENANT_ID, CLIENT_ID, CLIENT_SECRET, GRAPH_SENDER_EMAIL) or SMTP vars (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS).";
      console.warn(hint);
      return { sent: false };
    }

    const displayName = input.name?.trim() || "there";
    const appUrl = input.appUrl || process.env.APP_URL || "http://localhost:5000";
    const logoUrl = process.env.EMAIL_LOGO_URL || "";
    const supportEmail = process.env.SUPPORT_EMAIL || from;
    const safeAppUrl = appUrl.replace(/\/$/, "");
    const html = `
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f3f4f6;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="620" style="max-width:620px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="background:#f3f4f6;padding:18px 24px;border-bottom:1px solid #e5e7eb;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                  <tr>
                    <td style="vertical-align:middle;">
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                        <tr>
                          <td style="vertical-align:middle;">
                            ${logoUrl
                              ? `<img src="${logoUrl}" alt="ObservaIQ logo" style="height:32px;width:auto;display:block;" />`
                              : `<span style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:7px;background:#f59e0b;color:#ffffff;font-size:14px;font-weight:700;">~</span>`}
                          </td>
                          <td style="vertical-align:middle;padding-left:10px;">
                            <div style="font-size:30px;font-weight:700;line-height:1;color:#0f172a;">ObservaIQ</div>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 24px;">
                <h2 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:#111827;">Verify your email address</h2>
                <p style="margin:0 0 10px;font-size:15px;color:#374151;">Hi ${displayName},</p>
                <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151;">
                  Thanks for creating your ObservaIQ account. Please verify your email to activate access and continue to your dashboard.
                </p>
                <p style="margin:0 0 20px;">
                  <a href="${input.verificationUrl}" style="display:inline-block;background:#f59e0b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:11px 18px;border-radius:8px;">Verify Email</a>
                </p>
                <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;">
                  <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;">Verification Link</p>
                  <p style="margin:0;font-size:12px;line-height:1.5;color:#374151;word-break:break-all;">${input.verificationUrl}</p>
                </div>
              </td>
            </tr>
            <tr>
              <td style="border-top:1px solid #e5e7eb;padding:16px 24px;background:#fcfcfd;">
                <p style="margin:0 0 8px;font-size:12px;color:#6b7280;">Quick links</p>
                <p style="margin:0;font-size:12px;line-height:1.7;">
                  <a href="${safeAppUrl}/login" style="color:#f59e0b;text-decoration:none;">Login</a>
                  <span style="color:#9ca3af;"> | </span>
                  <a href="${input.verificationUrl}" style="color:#f59e0b;text-decoration:none;">Verification Link</a>
                  <span style="color:#9ca3af;"> | </span>
                  <a href="mailto:${supportEmail}" style="color:#f59e0b;text-decoration:none;">Support</a>
                </p>
                <p style="margin:10px 0 0;font-size:11px;color:#9ca3af;">If you did not request this, you can safely ignore this email.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  `;
    const text = [
      "ObservaIQ - Verify your email",
      "",
      `Hi ${displayName},`,
      "Please verify your email to activate your account.",
      "",
      `Verify: ${input.verificationUrl}`,
      "",
      `Login: ${safeAppUrl}/login`,
      `Support: ${supportEmail}`,
    ].join("\n");

    await sender.sendMail({
      from,
      to: input.to,
      subject: "Verify your ObservaIQ email",
      text,
      html,
    });
    return { sent: true };
  } catch (error) {
    console.warn("[email-verification] Failed to send verification email.", error);
    return { sent: false };
  }
}
