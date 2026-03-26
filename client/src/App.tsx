import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthGuard } from "@/pages/auth/AuthGuard";
import NotFound from "@/pages/not-found";

import Login from "./pages/auth/Login";
import Signup from "./pages/auth/Signup";
import AcceptInvite from "./pages/auth/AcceptInvite";
import OrgSettings from "./pages/org/OrgSettings";

import LandingPage from "./pages/LandingPage";
import ApplicationsList from "./pages/applications/ApplicationsList";
import ApplicationDashboard from "./pages/applications/ApplicationDashboard";
import ApplicationIncidents from "./pages/applications/ApplicationIncidents";
import ApplicationForecast from "./pages/applications/ApplicationForecast";
import ApplicationCapacity from "./pages/applications/ApplicationCapacity";
import CapacityPlanningGlobal from "./pages/capacity/CapacityPlanningGlobal";
import ClusterCapacity from "./pages/capacity/ClusterCapacity";
import CapacityRiskDetail from "./pages/capacity/CapacityRiskDetail";
import ProblemDetail from "./pages/problems/ProblemDetail";
import OtelOverview from "./pages/otel/OtelOverview";
import OtelFlow from "./pages/otel/OtelFlow";
import BusinessView from "./pages/persona/BusinessView";
import SreView from "./pages/persona/SreView";
import RuntimeView from "./pages/runtime/RuntimeView";
import AiInsights from "./pages/ai/AiInsights";
import RootCause from "./pages/ai/RootCause";
import CorrelationInsights from "./pages/ai/CorrelationInsights";
import Recommendations from "./pages/ai/Recommendations";
import ServiceRiskRanking from "./pages/ai/ServiceRiskRanking";
import InsightNavigator from "./pages/ai/InsightNavigator";
import ServersList from "./pages/applications/ServersList";
import ServerDetail from "./pages/applications/ServerDetail";
import IncidentDetail from "./pages/incidents/IncidentDetail";
import IncidentsDashboard from "./pages/incidents/IncidentsDashboard";
import AlertsDashboard from "./pages/alerts/AlertsDashboard";
import AlertDetail from "./pages/alerts/AlertDetail";
import ErrorsDashboard from "./pages/errors/ErrorsDashboard";
import ErrorDetail from "./pages/errors/ErrorDetail";
import Profile from "./pages/profile/Profile";
import Integrations from "./pages/integrations/Integrations";
import Subscription from "./pages/subscription/Subscription";

function Router() {
  return (
    <AuthGuard>
      <Switch>
        {/* Public auth routes */}
        <Route path="/login" component={Login} />
        <Route path="/signup" component={Signup} />
        <Route path="/accept-invite" component={AcceptInvite} />

        {/* Protected app routes */}
        <Route path="/" component={LandingPage} />
        <Route path="/applications" component={ApplicationsList} />
        <Route path="/applications/:id" component={ApplicationDashboard} />
        <Route path="/applications/:id/incidents" component={ApplicationIncidents} />
        <Route path="/applications/:id/forecast" component={ApplicationForecast} />
        <Route path="/applications/:id/capacity" component={ApplicationCapacity} />
        <Route path="/capacity-planning/detail/:riskId" component={CapacityRiskDetail} />
        <Route path="/capacity-planning/cluster/:clusterId" component={ClusterCapacity} />
        <Route path="/capacity-planning" component={CapacityPlanningGlobal} />
        <Route path="/problems/:id" component={ProblemDetail} />
        <Route path="/applications/:id/servers/:serverId" component={ServerDetail} />
        <Route path="/applications/:id/servers" component={ServersList} />
        <Route path="/incidents" component={IncidentsDashboard} />
        <Route path="/incidents/:incidentId" component={IncidentDetail} />
        <Route path="/alerts/:alertId" component={AlertDetail} />
        <Route path="/alerts" component={AlertsDashboard} />
        <Route path="/errors/:errorId" component={ErrorDetail} />
        <Route path="/errors" component={ErrorsDashboard} />
        <Route path="/otel" component={OtelOverview} />
        <Route path="/otel/flow" component={OtelFlow} />
        <Route path="/persona/business" component={BusinessView} />
        <Route path="/persona/sre" component={SreView} />
        <Route path="/runtime/:service" component={RuntimeView} />
        <Route path="/ai/insights" component={AiInsights} />
        <Route path="/ai/root-cause" component={RootCause} />
        <Route path="/ai/correlation" component={CorrelationInsights} />
        <Route path="/ai/recommendations" component={Recommendations} />
        <Route path="/ai/risk-ranking" component={ServiceRiskRanking} />
        <Route path="/ai/insight-navigator" component={InsightNavigator} />
        <Route path="/profile" component={Profile} />
        <Route path="/integrations" component={Integrations} />
        <Route path="/subscription" component={Subscription} />
        <Route path="/org/settings" component={OrgSettings} />
        <Route component={NotFound} />
      </Switch>
    </AuthGuard>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
