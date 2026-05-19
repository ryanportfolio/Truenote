import { Route, Switch, Redirect } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { ChatPage } from "@/pages/Chat";
import { AdminPage } from "@/pages/Admin";

export function App(): JSX.Element {
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={() => <Redirect to="/chat" />} />
        <Route path="/chat" component={ChatPage} />
        <Route path="/admin/documents" component={AdminPage} />
        <Route>
          <div className="mx-auto max-w-3xl px-6 py-8">
            <h1 className="text-xl font-semibold tracking-tight">Not found</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The page you're looking for doesn't exist.
            </p>
          </div>
        </Route>
      </Switch>
    </AppShell>
  );
}
