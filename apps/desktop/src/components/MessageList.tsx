import clsx from "clsx";
import { ArrowDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatItem } from "../lib/chat";
import { ToolCard } from "./ToolCard";

const NEAR_BOTTOM = 120;

export function MessageList({ items }: { items: ChatItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastResize = useRef(0);
  const [away, setAway] = useState(false);

  const toBottom = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useLayoutEffect(() => {
    if (stick.current) toBottom();
  }, [items]);

  // Layout changes (an approval card appearing, the window resizing) must not unstick the view.
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      lastResize.current = Date.now();
      if (stick.current) toBottom();
    });
    if (ref.current) ro.observe(ref.current);
    if (inner.current) ro.observe(inner.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        onScroll={(e) => {
          if (Date.now() - lastResize.current < 60) return;
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
          stick.current = near;
          setAway(!near);
        }}
        role="log"
        aria-live="polite"
        aria-label="Conversation"
      >
        <div ref={inner} className="mx-auto flex max-w-3xl flex-col gap-3">
          {items.length === 0 && <Empty />}
          {items.map((item) => (
            <Item key={item.id} item={item} />
          ))}
        </div>
      </div>
      {away && (
        <button
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-raised px-3 py-1 text-[12px] text-muted shadow-lg hover:text-text"
          onClick={() => {
            stick.current = true;
            setAway(false);
            toBottom();
          }}
        >
          <ArrowDown size={12} /> Latest
        </button>
      )}
    </div>
  );
}

function Empty() {
  return (
    <div className="mt-16 text-center text-muted">
      <div className="text-[15px] font-medium text-text">What should BetaCode work on?</div>
      <p className="mx-auto mt-2 max-w-sm leading-relaxed">Describe a change, a bug, or a question about this project. BetaCode inspects the code, edits files, runs your checks and reports what happened.</p>
      <p className="mt-3 text-[12px] text-faint">
        Try <code className="font-mono text-muted">/init</code> to create a BETACODE.md, or <code className="font-mono text-muted">/help</code>.
      </p>
    </div>
  );
}

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex flex-col items-end">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-faint">You</div>
          <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-lg bg-raised px-3 py-2 leading-relaxed">{item.text}</div>
        </div>
      );
    case "assistant":
      return (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-accent">BetaCode</div>
          <div className="whitespace-pre-wrap break-words leading-relaxed">
            {item.text}
            {item.streaming && <span className="bc-pulse ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-accent" aria-hidden />}
          </div>
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
    case "notice":
      return <div className={clsx("rounded-md border px-3 py-2 text-[12.5px]", item.tone === "error" ? "border-bad/30 bg-bad/5 text-bad" : "border-line bg-panel text-muted")}>{item.text}</div>;
  }
}
