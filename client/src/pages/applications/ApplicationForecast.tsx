import React from "react";
import { useParams } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useApplication, useForecast } from "@/hooks/use-applications";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from "recharts";
import { format } from "date-fns";
import { LineChart as LineChartIcon, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const formatXAxisDate = (tickItem: number) => {
  return format(new Date(tickItem), 'MMM d');
};

export default function ApplicationForecast() {
  const { id } = useParams();
  const appId = parseInt(id || "0", 10);
  
  const { data: app } = useApplication(appId);
  const { data: forecast, isLoading } = useForecast(appId);

  return (
    <AppLayout appId={appId}>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground flex items-center">
          <LineChartIcon className="w-8 h-8 mr-3 text-primary" />
          Predictive Forecasting
        </h1>
        <p className="text-muted-foreground mt-2">
          {app ? `AI-driven 7-day forecast for ${app.name}` : "Loading..."}
        </p>
      </div>

      <Alert className="mb-6 border-primary/20 bg-primary/5">
        <Info className="h-4 w-4 text-primary" />
        <AlertTitle className="text-primary font-semibold">AI Prediction Active</AlertTitle>
        <AlertDescription className="text-foreground">
          Our machine learning models have analyzed historical patterns to predict future resource saturation and response time degradation.
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border border-border shadow-sm">
          <CardHeader>
            <CardTitle>Predicted Response Time</CardTitle>
            <CardDescription>Expected P95 latency over next 7 days</CardDescription>
          </CardHeader>
          <CardContent className="h-[350px]">
            {!isLoading && forecast ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={forecast} margin={{ top: 20, right: 20, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="timestamp" tickFormatter={formatXAxisDate} stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip labelFormatter={(l) => format(new Date(l), 'MMM d, yyyy')} />
                  <Legend />
                  <Line type="monotone" dataKey="predictedResponseTime" name="Predicted Latency (ms)" stroke="hsl(var(--primary))" strokeWidth={3} strokeDasharray="5 5" dot={true} />
                </LineChart>
              </ResponsiveContainer>
            ) : null}
          </CardContent>
        </Card>

        <Card className="border border-border shadow-sm">
          <CardHeader>
            <CardTitle>Predicted CPU Saturation</CardTitle>
            <CardDescription>Expected infrastructure load over next 7 days</CardDescription>
          </CardHeader>
          <CardContent className="h-[350px]">
             {!isLoading && forecast ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={forecast} margin={{ top: 20, right: 20, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="timestamp" tickFormatter={formatXAxisDate} stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} domain={[0, 100]} />
                  <Tooltip labelFormatter={(l) => format(new Date(l), 'MMM d, yyyy')} />
                  <Legend />
                  <Line type="monotone" dataKey="predictedCpu" name="Predicted CPU %" stroke="hsl(var(--status-warning))" strokeWidth={3} strokeDasharray="5 5" dot={true} />
                </LineChart>
              </ResponsiveContainer>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
