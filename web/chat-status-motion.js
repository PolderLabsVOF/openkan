// OpenKan chat status motion — pixel-first GSAP cues. Live work loops with a
// distinct rhythm; terminal states run once, clear their timeline, and settle.
(() => {
  "use strict";

  const MODES = Object.freeze({
    thinking: { label: "Thinking", cells: 8 },
    reading: { label: "Reading", cells: 6 },
    command: { label: "Running command", cells: 7 },
    editing: { label: "Editing", cells: 7 },
    agent: { label: "Delegating", cells: 5 },
    orchestration: { label: "Coordinating", cells: 5 },
    mcp: { label: "Calling MCP", cells: 6 },
    writing: { label: "Writing response", cells: 3 },
    // A compact eight-point pixel flare: completion is a resolved signal,
    // not a checkmark and never an idle loader.
    complete: { label: "Completed", cells: 8 },
    error: { label: "Needs attention", cells: 5 },
  });

  function modeFor(status = {}) {
    const value = `${status.phase || ""} ${status.label || ""} ${status.name || ""}`.toLowerCase();
    if (/(error|failed|denied|cancel)/.test(value)) return "error";
    if (/(complete|finished|done|success)/.test(value)) return "complete";
    if (/(mcp)/.test(value)) return "mcp";
    if (/(team|workflow|orchestrat)/.test(value)) return "orchestration";
    if (/(subagent|delegat|agent)/.test(value)) return "agent";
    if (/(read|search|find|fetch|glob|grep)/.test(value)) return "reading";
    if (/(write|edit|patch|save)/.test(value)) return "editing";
    if (/(bash|command|run(?:ning)?|terminal|exec)/.test(value)) return "command";
    if (/(respond|stream|writing response)/.test(value)) return "writing";
    return "thinking";
  }

  function markup(status = {}) {
    const mode = modeFor(status);
    const config = MODES[mode];
    const pixels = Array.from({ length: config.cells }, (_, index) => `<i class="chat-status-motion__pixel chat-status-motion__pixel--${index}" aria-hidden="true"></i>`).join("");
    return `<span class="chat-status-motion chat-status-motion--${mode}" data-chat-status-motion="${mode}" role="img" aria-label="${config.label}"><span class="chat-status-motion__pixels">${pixels}</span></span>`;
  }

  function stop(node) {
    if (!node) return;
    const timeline = node._chatStatusTimeline;
    if (timeline) timeline.kill();
    const gsap = window.gsap;
    const pixels = [...node.querySelectorAll?.(".chat-status-motion__pixel") || []];
    gsap?.killTweensOf?.(pixels);
    delete node._chatStatusTimeline;
    delete node.dataset.chatStatusAnimating;
  }

  function reducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  function animate(node) {
    if (!node) return;
    stop(node);
    const gsap = window.gsap;
    const mode = node.dataset.chatStatusMotion || "thinking";
    const pixels = [...node.querySelectorAll(".chat-status-motion__pixel")];
    const terminal = mode === "complete" || mode === "error";
    if (!gsap || !pixels.length || reducedMotion()) {
      gsap?.set?.(pixels, { autoAlpha: 1, x: 0, y: 0, scale: 1, scaleY: 1, rotation: 0 });
      if (terminal) node.dataset.chatStatusSettled = "true";
      return;
    }

    delete node.dataset.chatStatusSettled;
    if (terminal) node.dataset.chatStatusAnimating = "true";
    gsap.set(pixels, { autoAlpha: 0.26, x: 0, y: 0, scale: 0.9, scaleY: 1, rotation: 0, transformOrigin: "50% 50%" });
    // Only live states repeat. Terminal status always owns a finite timeline.
    const tl = gsap.timeline({ repeat: terminal ? 0 : -1, defaults: { ease: "sine.inOut" } });
    const even = pixels.filter((_, index) => index % 2 === 0);
    const odd = pixels.filter((_, index) => index % 2 === 1);

    switch (mode) {
      case "thinking":
        tl.to(pixels, { autoAlpha: 0.66, scale: 1, duration: 0.22, stagger: { each: 0.05, from: "center" } })
          .to(even, { autoAlpha: 1, y: -2, scale: 1.2, duration: 0.24, stagger: { each: 0.075, from: "center" } }, "<.05")
          .to(odd, { autoAlpha: 0.9, y: 2, scale: 1.1, duration: 0.24, stagger: { each: 0.075, from: "center" } }, "<")
          .to(pixels, { autoAlpha: 0.3, x: 0, y: 0, scale: 0.9, duration: 0.34, stagger: { each: 0.04, from: "edges" } });
        break;
      case "reading":
        tl.to(pixels, { autoAlpha: 0.36, duration: 0.1 })
          .to(pixels, { autoAlpha: 1, scaleY: 1.45, duration: 0.14, stagger: { each: 0.065, from: "start" } })
          .to(pixels, { autoAlpha: 0.32, scaleY: 0.92, duration: 0.16, stagger: { each: 0.065, from: "end" } });
        break;
      case "command":
        tl.to(pixels, { autoAlpha: 0.34, duration: 0.1 })
          .to(pixels, { autoAlpha: 1, x: 2, duration: 0.1, stagger: { each: 0.05, from: "start" } })
          .to(pixels, { autoAlpha: 0.42, x: 0, duration: 0.13, stagger: { each: 0.05, from: "end" } });
        break;
      case "editing":
        tl.to(pixels, { autoAlpha: 1, rotation: -24, y: -2, scale: 1.14, duration: 0.19, stagger: { each: 0.055, from: "start" } })
          .to(pixels, { autoAlpha: 0.3, rotation: 0, y: 1, scale: 0.88, duration: 0.26, stagger: { each: 0.055, from: "end" } });
        break;
      case "agent":
        tl.to(pixels, { autoAlpha: 1, scale: 1.28, duration: 0.23, stagger: { each: 0.085, from: "center" } })
          .to(pixels, { autoAlpha: 0.35, scale: 0.76, duration: 0.28, stagger: { each: 0.085, from: "edges" } });
        break;
      case "orchestration":
        tl.to(even, { autoAlpha: 1, x: 2, y: -1, duration: 0.19, stagger: { each: 0.09, from: "start" } })
          .to(odd, { autoAlpha: 1, x: -2, y: 1, duration: 0.19, stagger: { each: 0.09, from: "end" } }, "<")
          .to(pixels, { autoAlpha: 0.3, x: 0, y: 0, duration: 0.26 });
        break;
      case "mcp":
        tl.to(even, { autoAlpha: 1, scale: 1.24, duration: 0.17 })
          .to(odd, { autoAlpha: 1, scale: 1.24, duration: 0.17 }, "<.11")
          .to(pixels, { autoAlpha: 0.32, scale: 0.86, duration: 0.22 });
        break;
      case "writing":
        tl.to(pixels, { autoAlpha: 1, y: -2, scale: 1.2, duration: 0.19, stagger: { each: 0.11, from: "start" } })
          .to(pixels, { autoAlpha: 0.34, y: 1, scale: 0.9, duration: 0.26, stagger: { each: 0.11, from: "end" } });
        break;
      case "complete": {
        const points = [pixels[0], pixels[2], pixels[4], pixels[6]].filter(Boolean);
        const diagonals = [pixels[1], pixels[3], pixels[5], pixels[7]].filter(Boolean);
        tl.to(points, { autoAlpha: 1, scale: 1.35, duration: 0.12, stagger: { each: 0.055, from: "center" } })
          .to(diagonals, { autoAlpha: 0.9, scale: 1.12, duration: 0.12, stagger: { each: 0.045, from: "center" } }, "<.045")
          .to(pixels, { autoAlpha: 1, x: 0, y: 0, scale: 1, scaleY: 1, rotation: 0, duration: 0.2, stagger: { each: 0.018, from: "center" } });
        break;
      }
      case "error":
        tl.to(pixels, { autoAlpha: 1, x: -2, duration: 0.09 })
          .to(pixels, { x: 2, duration: 0.12, repeat: 2, yoyo: true })
          .set(pixels, { autoAlpha: 1, x: 0, y: 0, scale: 1, scaleY: 1 });
        break;
    }

    node._chatStatusTimeline = tl;
    if (terminal) {
      tl.eventCallback("onComplete", () => {
        gsap.killTweensOf(pixels);
        gsap.set(pixels, { autoAlpha: 1, x: 0, y: 0, scale: 1, scaleY: 1, rotation: 0 });
        delete node.dataset.chatStatusAnimating;
        node.dataset.chatStatusSettled = "true";
        if (node._chatStatusTimeline === tl) delete node._chatStatusTimeline;
      });
    }
  }

  function render(status = {}) { return markup(status); }
  function animateWithin(root) { root?.querySelectorAll?.("[data-chat-status-motion]").forEach(animate); }
  window.OpenKanChatMotion = { render, animate, animateWithin, stop, modeFor };
})();
