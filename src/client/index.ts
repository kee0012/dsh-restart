/**
 * dsh-restart — client half.
 *
 * Hand-written bundle in the platform's ModuleLoader format (no build step, no
 * second copy of React: `react` is required from the host loader).
 *
 * Placement: the Windows desktop shell renders the title bar as a frame-wide
 * floating layer (`shell.overlay`), which is exactly where the shipped caption
 * menu (应用 / 编辑) lives. A button anchored to the top-right corner of that
 * layer therefore lands in the title bar strip, immediately left of the native
 * window controls drawn by Electron's `titleBarOverlay`.
 *
 * When that title bar does not exist (dsh web in a browser, macOS, or a future
 * shell without `data-windows-titlebar`), the same button is offered in the
 * conversation header instead — never both.
 */
window.__ModuleLoader__.load({ id: "dsh-restart", factory: (require) => {
    // The loader hands the factory only `require`; it owns the module record.
    const module = { exports: {} };
    const exports = module.exports;

    const React = require("react");
    const h = React.createElement;

    const PLUGIN_ID = "dsh-restart";
    const RESTART_ROUTE = "/dsh-restart/restart";
    const PING_ROUTE = "/dsh-restart/ping";

    /** Frame-wide floating layer of the app shell, above every column. */
    const TITLEBAR_SLOT = "shell.overlay";
    /** Fallback seat inside the session header, used off the desktop title bar. */
    const HEADER_SLOT = "conversation.session.header.utilities";

    /** Native Windows caption buttons are 46 CSS px wide each. */
    const CAPTION_BUTTON_WIDTH = 46;
    const CAPTION_BUTTON_COUNT = 3;
    /** Space between this button and the minimize button. */
    const TITLEBAR_GAP = 6;
    const TITLEBAR_HEIGHT = "var(--dsh-windows-titlebar-height, 40px)";

    const LABEL = "重启 DSH";
    const HINT = "立即重启 DeepSeek Harness（当前运行中的任务会中断）";
    const FONT = "var(--dsw-font-family, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif)";

    /**
     * True inside the desktop shell's custom title bar, where the native window
     * controls are drawn on top of the page.
     * @returns Whether this page has a Windows title bar strip.
     */
    function hasWindowsTitlebar() {
      try {
        return document.documentElement.hasAttribute("data-windows-titlebar");
      } catch (error) {
        return false;
      }
    }

    /**
     * Restart glyph: a heavy clockwise ring left open across the upper right,
     * with a large solid head riding out of it on the end tangent. The weight and
     * the exposed head are what keep the shape legible at 16px — a hairline ring
     * with a chevron head read as a broken letter G, and the reference's radial
     * speed lines turned into a fringe of pixels at this size, so they are gone.
     * @param props - `size` in pixels.
     * @returns Icon element.
     */
    function RestartIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h(
        "svg",
        {
          xmlns: "http://www.w3.org/2000/svg",
          viewBox: "0 0 24 24",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 3.1,
          strokeLinecap: "butt",
          strokeLinejoin: "miter",
          "aria-hidden": "true",
        },
        // Ring: 264° of arc, from just below 3 o'clock clockwise round to the upper right.
        h("path", { d: "M21 13.91 A9.2 9.2 0 1 1 12.96 2.85" }),
        // Head: solid triangle thrown clear of the ring on the end tangent.
        h("path", { d: "M16.94 3.27 L11.39 6.31 L12.14 -0.86Z", fill: "currentColor", stroke: "none" }),
      );
    }

    /**
     * Poll the host until a fresh process answers, then reload the page. Only
     * meaningful on `dsh web`: in the desktop app the window itself is replaced.
     * @param previousBoot - Boot id observed before the restart, when known.
     */
    function waitForRestart(previousBoot) {
      let baseline = previousBoot;
      let attempts = 0;
      const tick = () => {
        attempts += 1;
        if (attempts > 150) return;
        fetch(PING_ROUTE, { cache: "no-store" })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            if (data && data.ok === true) {
              if (baseline === null) {
                baseline = data.boot;
              } else if (data.boot !== baseline) {
                window.location.reload();
                return;
              }
            }
            window.setTimeout(tick, 500);
          })
          .catch(() => {
            window.setTimeout(tick, 500);
          });
      };
      window.setTimeout(tick, 800);
    }

    /**
     * The restart button plus its transient feedback.
     * @param props - `variant` is `titlebar` or `header`.
     * @returns Control element.
     */
    function RestartControl(props) {
      const isTitlebar = props.variant === "titlebar";
      const [phase, setPhase] = React.useState("idle");
      const [error, setError] = React.useState("");
      const [hover, setHover] = React.useState(false);
      const bootRef = React.useRef(null);

      const dismiss = () => {
        setPhase("idle");
        setError("");
      };

      const start = () => {
        if (phase === "restarting") return;
        setPhase("restarting");
        setError("");
        const run = async () => {
          try {
            const ping = await fetch(PING_ROUTE, { cache: "no-store" });
            if (ping.ok) {
              const before = await ping.json();
              bootRef.current = before && before.boot ? before.boot : null;
            }
          } catch (probeError) {
            bootRef.current = null;
          }
          let response;
          try {
            response = await fetch(RESTART_ROUTE, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
              keepalive: true,
            });
          } catch (networkError) {
            setPhase("error");
            setError(`无法连接 DSH 服务（${String((networkError && networkError.message) || networkError)}）`);
            return;
          }
          let payload = null;
          try {
            payload = await response.json();
          } catch (parseError) {
            payload = null;
          }
          if (!response.ok || !payload || payload.ok !== true) {
            setPhase("error");
            setError(String((payload && payload.error) || `HTTP ${response.status}`));
            return;
          }
          waitForRestart(bootRef.current);
        };
        run();
      };

      const buttonStyle = isTitlebar
        ? {
            position: "absolute",
            top: 0,
            right: CAPTION_BUTTON_WIDTH * CAPTION_BUTTON_COUNT + TITLEBAR_GAP,
            height: TITLEBAR_HEIGHT,
            width: 36,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            margin: 0,
            padding: 0,
            border: "none",
            borderRadius: 6,
            background: hover
              ? "var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.18))"
              : "transparent",
            color: "var(--dsw-alias-label-primary, inherit)",
            cursor: "pointer",
            pointerEvents: "auto",
            WebkitAppRegion: "no-drag",
            transition: "background 120ms ease",
          }
        : {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 30,
            height: 30,
            margin: 0,
            padding: 0,
            border: "none",
            borderRadius: 8,
            background: hover ? "color-mix(in srgb, currentColor 12%, transparent)" : "transparent",
            color: "inherit",
            cursor: "pointer",
            flexShrink: 0,
            WebkitAppRegion: "no-drag",
            transition: "background 120ms ease",
          };

      const children = [
        h(
          "button",
          {
            key: "button",
            type: "button",
            title: HINT,
            "aria-label": LABEL,
            disabled: phase === "restarting",
            onClick: start,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            style: buttonStyle,
          },
          h(RestartIcon, { size: isTitlebar ? 16 : 15 }),
        ),
      ];

      if (phase === "restarting") {
        children.push(
          h(
            "div",
            {
              key: "overlay",
              style: {
                position: "fixed",
                inset: 0,
                zIndex: 2147483647,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                background: "var(--dsw-alias-bg-base, #ffffff)",
                color: "var(--dsw-alias-label-primary, inherit)",
                fontFamily: FONT,
              },
            },
            h("div", { style: { fontSize: 15, fontWeight: 600 } }, "DSH 正在重启…"),
            h("div", { style: { fontSize: 13, opacity: 0.7 } }, "窗口会在几秒后自动重新打开"),
          ),
        );
      }

      if (phase === "error") {
        children.push(
          h(
            "div",
            {
              key: "error",
              onClick: dismiss,
              style: {
                position: "fixed",
                top: isTitlebar ? `calc(${TITLEBAR_HEIGHT} + 8px)` : 56,
                right: 16,
                zIndex: 2147483647,
                maxWidth: 380,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28))",
                background: "var(--dsw-alias-bg-elevated, #ffffff)",
                color: "var(--dsw-alias-label-primary, inherit)",
                boxShadow: "0 8px 28px rgba(0, 0, 0, 0.28)",
                fontFamily: FONT,
                fontSize: 13,
                lineHeight: 1.45,
                cursor: "pointer",
              },
            },
            "重启失败：",
            error,
            h("div", { style: { opacity: 0.6, marginTop: 4 } }, "点击关闭；详情见 %TEMP%\\dsh-restart.log"),
          ),
        );
      }

      return h(React.Fragment, null, children);
    }

    /** Title bar placement, only where the desktop title bar strip exists. */
    function TitlebarRestart() {
      if (!hasWindowsTitlebar()) return null;
      return h(RestartControl, { variant: "titlebar" });
    }

    /** Header placement for every other host (dsh web, macOS, plain browsers). */
    function HeaderRestart() {
      if (hasWindowsTitlebar()) return null;
      return h(RestartControl, { variant: "header" });
    }

    /** The slot service is the only service this half touches. */
    const inject = ["slots"];

    /**
     * Register the button in both candidate seats; each one renders itself only
     * in the host it belongs to.
     * @param ctx - Cordis client context with the injected `slots` service.
     */
    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject(TITLEBAR_SLOT, () =>
            ctx.slots.register({ name: TITLEBAR_SLOT, id: `${PLUGIN_ID}:titlebar`, order: 100 }, TitlebarRestart),
          ),
        `${PLUGIN_ID}: title bar restart button`,
      );
      ctx.effect(
        () =>
          ctx.slots.inject(HEADER_SLOT, () =>
            ctx.slots.register({ name: HEADER_SLOT, id: `${PLUGIN_ID}:header`, order: 50 }, HeaderRestart),
          ),
        `${PLUGIN_ID}: conversation header restart button`,
      );
    }

    module.exports.inject = inject;
    module.exports.apply = apply;
    return module.exports;
  },
});
