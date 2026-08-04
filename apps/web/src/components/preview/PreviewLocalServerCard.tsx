import { DotMatrix } from "~/components/ui/dot-matrix";
import { BrowserMockup } from "./BrowserMockup";
import type { PreviewableServer } from "./useDiscoveredLocalServers";

interface Props {
  server: PreviewableServer;
  onOpen: () => void;
}

export function PreviewLocalServerCard({ server, onOpen }: Props) {
  const subtitle = describeServer(server);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <BrowserMockup className="size-7 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{subtitle}</span>
        <span className="truncate text-xs text-muted-foreground">
          {server.host}:{server.port}
        </span>
      </div>
      {server.listening ? <PulsingDot /> : <DimDot />}
    </button>
  );
}

function describeServer(server: PreviewableServer): string {
  if (server.processName) return server.processName;
  if (server.listening) return "Listening";
  if (server.source === "configured") return "Configured";
  return "Recently seen";
}

function PulsingDot() {
  return <DotMatrix state="live" label="Listening" className="size-3 shrink-0" />;
}

function DimDot() {
  return (
    <DotMatrix
      state="idle"
      label="Not currently listening"
      className="size-3 shrink-0 text-muted-foreground/40"
    />
  );
}
