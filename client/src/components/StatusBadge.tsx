import React from "react";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle, XCircle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: string;
  className?: string;
  showIcon?: boolean;
}

export function StatusBadge({ status, className, showIcon = true }: StatusBadgeProps) {
  const normalizedStatus = status.toLowerCase();
  
  let variant: "default" | "secondary" | "destructive" | "outline" = "default";
  let icon = null;
  let colorClass = "";

  if (["healthy", "normal", "resolved", "low"].includes(normalizedStatus)) {
    variant = "outline";
    icon = <CheckCircle2 className="w-3.5 h-3.5 mr-1" />;
    colorClass = "text-status-healthy border-status-healthy bg-status-healthy-subtle";
  } else if (["warning", "slow", "medium", "open"].includes(normalizedStatus)) {
    variant = "outline";
    icon = <AlertTriangle className="w-3.5 h-3.5 mr-1" />;
    colorClass = "text-status-warning border-status-warning bg-status-warning-subtle";
  } else if (["critical", "very slow", "stalled", "errors", "high"].includes(normalizedStatus)) {
    variant = "outline";
    icon = <XCircle className="w-3.5 h-3.5 mr-1" />;
    colorClass = "text-status-critical border-status-critical bg-status-critical-subtle";
  } else {
    variant = "secondary";
    icon = <Clock className="w-3.5 h-3.5 mr-1" />;
  }

  return (
    <Badge variant={variant} className={cn("px-2.5 py-0.5 font-medium whitespace-nowrap", colorClass, className)}>
      {showIcon && icon}
      {status}
    </Badge>
  );
}
