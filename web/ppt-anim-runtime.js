/**
 * ppt-anim-runtime.js — browser preview player for the data-ppt-* DSL.
 *
 * It reads the SAME attributes the compiler reads (data-ppt-anim / data-ppt-build
 * / data-ppt-glow), so what the user previews matches what lands in the .pptx.
 * Fidelity is approximate (preview only); the OOXML compiler remains the source
 * of truth. No build step — drop this <script> into the preview HTML.
 *
 * Controls: click / ArrowRight / Space / PageDown = advance;
 * ArrowLeft / PageUp = previous slide; R = replay current slide.
 */
(function () {
  "use strict";

  function parseDecl(v) {
    const o = {};
    for (const part of String(v || "").split(";")) {
      const i = part.indexOf(":");
      if (i < 0) { const f = part.trim(); if (f) o[f] = true; continue; }
      o[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return o;
  }
  const animSegments = (v) => String(v || "").split("|").map((s) => s.trim()).filter(Boolean);

  const num = (v, d) => (v == null || v === "" ? d : Number(v));

  function normTrigger(t) {
    const s = String(t || "").toLowerCase().replace(/[-_\s]/g, "");
    if (s.startsWith("withprev") || s === "with") return "withPrevious";
    if (s.startsWith("afterprev") || s === "after") return "afterPrevious";
    if (s === "auto") return "auto";
    return "onClick";
  }

  // Approximate visual keyframes per effect, for preview.
  function keyframes(effect, exit) {
    const e = effect;
    if (exit) return { opacity: [1, 0] };
    if (e === "appear") return { opacity: [0, 1] };
    if (e === "wipe") return { clipPath: ["inset(0 0 100% 0)", "inset(0 0 0% 0)"], opacity: [1, 1] };
    if (e === "circle" || e === "diamond" || e === "box")
      return { transform: ["scale(0.2)", "scale(1)"], opacity: [0, 1] };
    if (e === "blinds" || e === "checkerboard" || e === "randombars" || e === "dissolve" ||
        e === "wedge" || e === "wheel" || e === "plus" || e === "fade")
      return { opacity: [0, 1] };
    if (e === "spin") return null; // handled specially
    if (e === "grow") return { transform: ["scale(1)", "scale(1.4)"] };
    if (e === "shrink") return { transform: ["scale(1)", "scale(0.5)"] };
    if (e === "pulse") return { transform: ["scale(1)", "scale(1.1)", "scale(1)"] };
    return { opacity: [0, 1] };
  }

  function itemFromDecl(el, d) {
    const isCompose = d.compose !== undefined || d.combo !== undefined ||
      d.effect === "compose" || d.effect === "combo" || d.entrance === "compose";
    const opacity = String(d.opacity || d.fade || "").toLowerCase();
    const exit = !!d.exit || opacity === "out";
    const effect = isCompose ? "compose" : d.entrance || d.exit || (d.appear !== undefined ? "appear" : null) ||
      d.emphasis || (d.motion || d.path ? "motionPath" : null) || "fade";
    const entrance = (isCompose && opacity === "in") || (!!(d.entrance || d.appear !== undefined) && !exit);
    return { el, effect, exit, entrance, opacity,
      trigger: normTrigger(d.trigger), dur: num(d.dur, 450), delay: num(d.delay, 0),
      spins: num(d.spins, 1), scale: num(d.scale, null), path: d.path || d.motion || "",
      x: num(d.x ?? d.dx, 0), y: num(d.y ?? d.dy, 0),
      scaleFrom: num(d.scaleFrom, null), scaleTo: num(d.scaleTo, null),
      rotateFrom: num(d.rotateFrom, null), rotateTo: num(d.rotateTo, null) };
  }

  function buildSequenceItems(scope) {
    const items = [];
    const componentSel = ".ppt-textbox,.ppt-shape,.ppt-line,.ppt-picture";
    for (const container of Array.from(scope.querySelectorAll("[data-ppt-sequence]"))) {
      const d = parseDecl(container.getAttribute("data-ppt-sequence"));
      let targets = [];
      if (d.selector) {
        try { targets = Array.from(container.querySelectorAll(d.selector)); }
        catch (e) { targets = []; }
      } else {
        targets = Array.from(container.querySelectorAll(componentSel));
      }
      targets = targets.filter((el) => el.matches(componentSel));
      const dur = num(d.dur, 520);
      const gap = num(d.gap ?? d.stagger, Math.max(0, dur - num(d.overlap, 0)));
      const baseDelay = num(d.delay, 0);
      const base = { ...d };
      if (!(d.compose || d.combo || d.effect || d.entrance || d.exit || d.emphasis || d.motion || d.path || d.appear || d.recolor)) {
        base.compose = true;
        base.opacity = d.opacity || "in";
        base.x = d.x ?? d.dx ?? -42;
        base.y = d.y ?? d.dy ?? 16;
        base.scaleFrom = d.scaleFrom ?? .96;
        base.scaleTo = d.scaleTo ?? 1;
        base.dur = d.dur ?? 520;
      }
      targets.forEach((el, index) => {
        items.push(itemFromDecl(el, {
          ...base,
          trigger: index === 0 ? (d.trigger || "afterPrev") : "withPrev",
          delay: baseDelay + index * gap,
        }));
      });
    }
    return items;
  }

  function buildItems(root) {
    const scope = root || document;
    const nodes = Array.from(scope.querySelectorAll("[data-ppt-anim],[data-ppt-build]"));
    const items = buildSequenceItems(scope);
    for (const el of nodes) {
      const animRaw = el.getAttribute("data-ppt-anim");
      const buildRaw = el.getAttribute("data-ppt-build");
      if (buildRaw) {
        const d = parseDecl(buildRaw);
        const paras = Array.from(el.children).length
          ? Array.from(el.children)
          : String(el.innerHTML).split(/<br\s*\/?>(?![^<]*>)/i).length
            ? splitParas(el) : [el];
        for (const p of paras) {
          items.push({ el: p, effect: d.effect || "fade", exit: false,
            trigger: normTrigger(d.trigger), dur: num(d.dur, 450), delay: 0, entrance: true });
        }
        continue;
      }
      for (const seg of animSegments(animRaw)) {
        const d = parseDecl(seg);
        items.push(itemFromDecl(el, d));
      }
    }
    return items;
  }

  function splitParas(el) {
    // Wrap text lines (split on <br>) in spans so each can build separately.
    const html = el.innerHTML;
    if (!/<br/i.test(html)) return [el];
    const parts = html.split(/<br\s*\/?>(?![^<]*>)/i);
    el.innerHTML = parts.map((p) => `<span class="ppt-para">${p}</span>`).join("");
    return Array.from(el.querySelectorAll(".ppt-para"));
  }

  function applyGlow() {
    for (const el of document.querySelectorAll("[data-ppt-glow]")) {
      const d = parseDecl(el.getAttribute("data-ppt-glow"));
      const color = d.color || "#fff";
      const r = num(d.radius || d.blur, 12);
      const a = d.alpha == null ? 1 : Number(d.alpha);
      el.style.filter = `drop-shadow(0 0 ${r}px ${hexA(color, a)})`;
    }
  }

  function hexA(color, a) {
    if (a >= 1) return color;
    const m = String(color).replace("#", "");
    if (m.length < 6) return color;
    const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  function groupByClick(items) {
    const groups = [];
    let cur = null;
    for (const it of items) {
      if (!cur || it.trigger === "onClick") { cur = { items: [] }; groups.push(cur); }
      cur.items.push(it);
    }
    return groups;
  }

  function setInitial(items) {
    for (const it of items) {
      try { it.el.getAnimations().forEach((a) => a.cancel()); } catch (e) {}
      if (it.entrance) it.el.style.visibility = "hidden";
      else it.el.style.visibility = "visible";
    }
  }

  function motionKeyframes(it) {
    const values = String(it.path || "").match(/-?\d*\.?\d+/g);
    if (!values || values.length < 4) return { opacity: [1, 1] };
    const nums = values.map(Number).filter((n) => Number.isFinite(n));
    if (nums.length < 4) return { opacity: [1, 1] };
    const endX = nums[nums.length - 2];
    const endY = nums[nums.length - 1];
    const dx = Math.abs(endX) <= 1 ? endX * 1280 : endX;
    const dy = Math.abs(endY) <= 1 ? endY * 720 : endY;
    return { transform: ["translate(0,0)", `translate(${dx}px,${dy}px)`] };
  }

  function composeTransform(x, y, scale, rotate) {
    const parts = [];
    if (x || y) parts.push(`translate(${x || 0}px,${y || 0}px)`);
    if (scale != null) parts.push(`scale(${scale})`);
    if (rotate != null) parts.push(`rotate(${rotate}deg)`);
    return parts.length ? parts.join(" ") : "none";
  }

  function composeKeyframes(it) {
    const out = {};
    const outMotion = it.opacity === "out" || it.exit;
    const fromX = outMotion ? 0 : it.x;
    const fromY = outMotion ? 0 : it.y;
    const toX = outMotion ? it.x : 0;
    const toY = outMotion ? it.y : 0;
    const transforms = [
      composeTransform(fromX, fromY, it.scaleFrom, it.rotateFrom),
      composeTransform(toX, toY, it.scaleTo, it.rotateTo),
    ];
    if (transforms[0] !== "none" || transforms[1] !== "none") out.transform = transforms;
    if (it.opacity === "in") out.opacity = [0, 1];
    else if (it.opacity === "out" || it.exit) out.opacity = [1, 0];
    return Object.keys(out).length ? out : { opacity: [0, 1] };
  }

  function playItem(it) {
    it.el.style.visibility = "visible";
    let kf;
    if (it.effect === "spin") {
      kf = { transform: [`rotate(0deg)`, `rotate(${360 * (it.spins || 1)}deg)`] };
    } else if (it.effect === "compose") {
      kf = composeKeyframes(it);
    } else if (it.effect === "motionPath") {
      kf = motionKeyframes(it);
    } else {
      kf = keyframes(it.effect, it.exit);
      if (it.scale != null && (it.effect === "grow" || it.effect === "shrink"))
        kf = { transform: ["scale(1)", `scale(${it.scale / 100})`] };
    }
    if (!kf) { return; }
    const opts = { duration: Math.max(1, it.dur), delay: it.delay || 0, fill: "forwards", easing: "ease" };
    if (it.effect === "pulse") opts.fill = "none";
    let animation = null;
    try { animation = it.el.animate(kf, opts); }
    catch (e) { it.el.style.opacity = it.exit ? "0" : "1"; }
    if (it.exit && animation) animation.addEventListener("finish", () => { it.el.style.visibility = "hidden"; });
  }

  function playGroup(g) {
    for (const it of g.items) playItem(it);
  }

  function autoLead(state) {
    while (state.idx < state.groups.length && state.groups[state.idx].items[0] &&
           state.groups[state.idx].items[0].trigger !== "onClick") {
      playGroup(state.groups[state.idx]);
      state.idx += 1;
    }
  }

  function enterState(state) {
    setInitial(state.items);
    state.idx = 0;
    autoLead(state);
  }

  function playNextGroup(state) {
    if (state.idx >= state.groups.length) return false;
    playGroup(state.groups[state.idx]);
    state.idx += 1;
    autoLead(state);
    return true;
  }

  function initDeck(sections) {
    const states = sections.map((section) => {
      const items = buildItems(section);
      return { section, items, groups: groupByClick(items), idx: 0 };
    });

    document.body.style.margin = document.body.style.margin || "0";
    document.body.style.overflow = "hidden";
    document.body.style.position = "relative";
    sections.forEach((section) => {
      section.style.position = "absolute";
      section.style.left = "0";
      section.style.top = "0";
      section.style.transition = section.style.transition || "opacity .35s ease";
    });

    let slideIdx = 0;
    function show(n) {
      const next = Math.max(0, Math.min(states.length - 1, Number(n) || 0));
      slideIdx = next;
      sections.forEach((section, i) => {
        section.style.opacity = i === slideIdx ? "1" : "0";
        section.style.pointerEvents = i === slideIdx ? "auto" : "none";
        section.style.zIndex = i === slideIdx ? "2" : "1";
      });
      enterState(states[slideIdx]);
      return slideIdx;
    }
    function advance() {
      if (!playNextGroup(states[slideIdx])) show(slideIdx + 1);
    }
    function previous() { show(slideIdx - 1); }
    function restart() { enterState(states[slideIdx]); }

    show(0);
    return {
      advance,
      previous,
      restart,
      show,
      current: () => slideIdx,
      count: states.length,
      groups: states.map((s) => s.groups),
    };
  }

  function initSinglePage() {
    const state = { items: buildItems(document), groups: [], idx: 0 };
    state.groups = groupByClick(state.items);
    enterState(state);
    function advance() { playNextGroup(state); }
    function restart() { enterState(state); }
    return { advance, previous: restart, restart, show: () => 0, current: () => 0, count: 1, groups: state.groups };
  }

  function init() {
    applyGlow();
    const sections = Array.from(document.querySelectorAll(".ppt-slide, [data-ppt='slide']"));
    const api = sections.length > 0 ? initDeck(sections) : initSinglePage();
    document.addEventListener("click", (e) => {
      if (e.target && e.target.closest && e.target.closest("[data-ppt-control]")) return;
      api.advance();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
        e.preventDefault(); api.advance();
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault(); api.previous();
      } else if (e.key && e.key.toLowerCase() === "r") {
        e.preventDefault(); api.restart();
      }
    });
    window.__pptPreview = api;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
