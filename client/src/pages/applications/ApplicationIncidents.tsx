import React from "react";
import { useParams, Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useApplication, useIncidents } from "@/hooks/use-applications";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { AlertOctagon, ChevronRight, ShieldAlert, BrainCircuit } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ApplicationIncidents() {
  const { id } = useParams();
  const appId = parseInt(id || "0", 10);
  
  const { data: app, isLoading: isAppLoading } = useApplication(appId);
  const { data: incidents, isLoading: isIncidentsLoading } = useIncidents(appId);

  return (
    <AppLayout appId={appId}>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground flex items-center">
          <ShieldAlert className="w-8 h-8 mr-3 text-status-critical" />
          Incident Intelligence
        </h1>
        <p className="text-muted-foreground mt-2">
          {app ? `Managing incidents for ${app.name}` : "Loading..."}
        </p>
      </div>

      <Card className="border border-border shadow-md">
        <CardContent className="p-0">
          {isIncidentsLoading ? (
            <div className="p-6 space-y-4">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-muted/50 text-muted-foreground font-medium border-b border-border text-sm">
                  <tr>
                    <th className="px-6 py-4">Incident</th>
                    <th className="px-6 py-4">Severity</th>
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4">Start Time</th>
                    <th className="px-6 py-4">Affected Tiers</th>
                    <th className="px-6 py-4 text-right">Impact Score</th>
                    <th className="px-6 py-4"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {incidents?.map((incident) => (
                    <tr key={incident.id} className="hover:bg-muted/30 transition-colors group">
                      <td className="px-6 py-4">
                        <div className="font-semibold text-foreground">{incident.title}</div>
                        <div className="text-xs text-muted-foreground mt-1 truncate max-w-xs">
                          {incident.recommendation}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <StatusBadge status={incident.severity} />
                      </td>
                      <td className="px-6 py-4">
                        <StatusBadge status={incident.status} />
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        {incident.startTime ? format(new Date(incident.startTime), "MMM d, HH:mm") : "—"}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex gap-1 flex-wrap">
                          {incident.affectedTiers.map((t: string) => (
                            <span key={t} className="px-2 py-1 bg-secondary text-secondary-foreground text-xs rounded-md border border-border">
                              {t}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full font-bold text-sm ${
                          incident.impactScore > 80 ? 'bg-status-critical/10 text-status-critical' : 
                          incident.impactScore > 50 ? 'bg-status-warning/10 text-status-warning' : 
                          'bg-primary/10 text-primary'
                        }`}>
                          {incident.impactScore}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right pr-6">
                        <Link href="/incidents/INC-0042">
                          <Button data-testid={`btn-investigate-${incident.id}`} variant="ghost" size="sm" className="text-primary hover:text-primary hover:bg-primary/10">
                            <BrainCircuit className="w-3.5 h-3.5 mr-1" /> Investigate <ChevronRight className="w-4 h-4 ml-1" />
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  ))}
                  {(!incidents || incidents.length === 0) && (
                    <tr>
                      <td colSpan={7} className="px-6 py-12 text-center">
                        <div className="flex flex-col items-center justify-center text-muted-foreground">
                          <AlertOctagon className="w-12 h-12 mb-4 opacity-20" />
                          <h3 className="text-lg font-medium text-foreground">No active incidents</h3>
                          <p>All systems are operating normally.</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </AppLayout>
  );
}
