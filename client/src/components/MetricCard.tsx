import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

interface MetricCardProps {
  title: string;
  value: string | number;
  unit?: string;
  trend?: {
    value: number;
    isPositiveGood: boolean;
  };
  icon?: React.ReactNode;
  isLoading?: boolean;
  className?: string;
}

export function MetricCard({ 
  title, 
  value, 
  unit, 
  trend, 
  icon, 
  isLoading,
  className 
}: MetricCardProps) {
  return (
    <Card className={cn("overflow-hidden border border-border shadow-sm hover:shadow-md transition-all duration-300", className)}>
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
          {icon && <div className="text-muted-foreground/60">{icon}</div>}
        </div>
        
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-4 w-32" />
          </div>
        ) : (
          <div>
            <div className="flex items-baseline">
              <span className="text-3xl font-bold tracking-tight text-foreground">
                {value}
              </span>
              {unit && <span className="ml-1 text-sm font-medium text-muted-foreground">{unit}</span>}
            </div>
            
            {trend && (
              <div className="mt-2 flex items-center text-sm">
                <span className={cn(
                  "font-medium flex items-center",
                  (trend.value > 0 && trend.isPositiveGood) || (trend.value < 0 && !trend.isPositiveGood) 
                    ? "text-status-healthy" 
                    : (trend.value === 0 ? "text-muted-foreground" : "text-status-critical")
                )}>
                  {trend.value > 0 ? "+" : ""}{trend.value}%
                </span>
                <span className="ml-1.5 text-muted-foreground">vs last hour</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
