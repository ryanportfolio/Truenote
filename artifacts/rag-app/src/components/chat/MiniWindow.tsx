import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { Link } from "wouter";

/**
 * The chat's pop-out mini window. Chrome and Edge 116+ get Document
 * Picture-in-Picture: a small window that stays on top of every other app,
 * so a CSR can ask from a corner while working in the CRM. Other browsers
 * get a small same-origin popup, which behaves like any normal window.
 *
 * Either way the window runs in this tab's JavaScript context: ChatPage keeps
 * the conversation state and portals a compact view into the window, so the
 * session cookie, program scope and in-flight asks carry over unchanged.
 */

const MINI_WIDTH = 400;
const MINI_HEIGHT = 600;

interface DocumentPictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPictureApi;
  }
}

const InMiniWindowContext = createContext(false);

/** True for components rendered inside the mini window. */
export function useInMiniWindow(): boolean {
  return useContext(InMiniWindowContext);
}

/** Whether the mini window can stay on top of other apps in this browser. */
export function miniWindowStaysOnTop(): boolean {
  return typeof window !== "undefined" && "documentPictureInPicture" in window;
}

async function requestMiniWindow(): Promise<Window | null> {
  const pip = window.documentPictureInPicture;
  if (pip) {
    try {
      return await pip.requestWindow({ width: MINI_WIDTH, height: MINI_HEIGHT });
    } catch {
      // Refused (no user activation, policy): fall back to the popup.
    }
  }
  // No `noopener`: the opener needs the window reference to render into it.
  const left = Math.max(0, window.screen.availWidth - MINI_WIDTH - 24);
  const top = Math.max(0, window.screen.availHeight - MINI_HEIGHT - 48);
  return window.open(
    "",
    "_blank",
    `popup,width=${MINI_WIDTH},height=${MINI_HEIGHT},left=${left},top=${top}`
  );
}

/** Copy this tab's stylesheets and root classes into the new window. */
function prepareDocument(target: Window): HTMLElement {
  const doc = target.document;
  doc.title = "Truenote";
  doc.documentElement.lang = document.documentElement.lang;
  doc.documentElement.className = document.documentElement.className;
  doc.body.className = document.body.className;
  for (const node of Array.from(document.head.querySelectorAll("link[rel='stylesheet'], style"))) {
    const copy = doc.importNode(node, true);
    // Resolve against this tab: the new window's document is about:blank.
    if (node instanceof HTMLLinkElement && copy instanceof HTMLLinkElement) {
      copy.href = node.href;
    }
    doc.head.appendChild(copy);
  }
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  return container;
}

export interface MiniWindowControls {
  /** The open mini window, or null. */
  win: Window | null;
  /** Render target inside the mini window. */
  container: HTMLElement | null;
  /** Opens (or focuses) the mini window. False when the browser blocked it. */
  open: () => Promise<boolean>;
  close: () => void;
}

export function useMiniWindow(): MiniWindowControls {
  const [state, setState] = useState<{ win: Window; container: HTMLElement } | null>(null);
  const winRef = useRef<Window | null>(null);

  const close = useCallback(() => {
    winRef.current?.close();
    winRef.current = null;
    setState(null);
    window.focus();
  }, []);

  const open = useCallback(async () => {
    if (winRef.current && !winRef.current.closed) {
      winRef.current.focus();
      return true;
    }
    const win = await requestMiniWindow();
    if (!win) return false;
    const container = prepareDocument(win);
    winRef.current = win;
    // The user closed the window from its own title bar.
    win.addEventListener("pagehide", () => {
      if (winRef.current !== win) return;
      winRef.current = null;
      setState(null);
    });
    setState({ win, container });
    return true;
  }, []);

  // A popup outlives its opener; once this tab unloads nothing renders into
  // it any more, so close it with the tab. (Picture-in-Picture closes itself.)
  useEffect(() => {
    function onTabHide(): void {
      winRef.current?.close();
    }
    window.addEventListener("pagehide", onTabHide);
    return () => window.removeEventListener("pagehide", onTabHide);
  }, []);

  // Leaving the chat page unmounts the state the window renders.
  useEffect(() => () => winRef.current?.close(), []);

  return { win: state?.win ?? null, container: state?.container ?? null, open, close };
}

export function MiniWindowPortal({
  container,
  children
}: {
  container: HTMLElement;
  children: ReactNode;
}): JSX.Element {
  return createPortal(
    <InMiniWindowContext.Provider value={true}>{children}</InMiniWindowContext.Provider>,
    container
  );
}

/**
 * A link into the app. Inside the mini window it opens a new tab instead:
 * navigating this tab would unmount the chat page and close the window.
 */
export function AppLink({
  href,
  className,
  children
}: {
  href: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const inMiniWindow = useInMiniWindow();
  if (inMiniWindow) {
    return (
      <a
        href={new URL(href, window.location.origin).href}
        target="_blank"
        rel="noopener"
        className={className}
      >
        {children}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
