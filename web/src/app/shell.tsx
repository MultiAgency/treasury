import { Link, useLocation } from "@tanstack/react-router";
import { useGateway } from "./gateway-context";
import { Workspace } from "./workspace";
import { AgentTaskBoundary } from "./agent-task-boundary";

/** Navigation does not wait for provider-dependent task observations. */
export function Shell() {
  const gateway = useGateway();
  const pathname = useLocation({ select: location => location.pathname });
  return gateway ? <Workspace gateway={gateway} pathname={pathname} taskLink={(task, className, active) =>
    <Link to={task.to} activeOptions={{ exact: true }} aria-current={active ? "page" : undefined} className={className}>{task.label}</Link>
  }><AgentTaskBoundary /></Workspace> : <AgentTaskBoundary />;
}
