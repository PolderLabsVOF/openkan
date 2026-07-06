// OpenKan — image upload, paste, drop, list, delete, lightbox.
//
// Public API (window.OpenKanImages):
//   list(taskId)                  -> Promise<ImageMeta[]>
//   upload(taskId, file, opts?)   -> Promise<ImageMeta>
//   remove(taskId, name)          -> Promise<void>
//   srcFor(taskId, name)          -> string  (URL for the image)
//   markdownFor(taskId, name)     -> string  (markdown reference)
//   copyMarkdown(taskId, name)    -> Promise<void>
//
// File handling (read as data URL via FileReader, POST JSON):
//   POST /api/tasks/<id>/images
//     { data: "<base64>", contentType: "image/png", filename: "shot.png" }
//   GET  /api/tasks/<id>/images             -> { images: ImageMeta[] }
//   DEL  /api/tasks/<id>/images/<name>      -> ok
//   GET  /api/tasks/<id>/images/<name>      -> image file (used as <img src>)

(() => {
  "use strict";

  const { api } = window.OpenKanAPI;

  const ALLOWED_TYPES = new Set([
    "image/png", "image/jpeg", "image/jpg", "image/gif",
    "image/webp", "image/svg+xml",
  ]);
  const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(fr.error || new Error("FileReader failed"));
      fr.readAsDataURL(file);
    });
  }

  function dataUrlToBase64(dataUrl) {
    // "data:image/png;base64,iVBORw0..." -> "iVBORw0..."
    const idx = dataUrl.indexOf(",");
    return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
  }

  function inferContentType(file) {
    if (file?.type && ALLOWED_TYPES.has(file.type)) return file.type;
    // Fallback by extension.
    const name = String(file?.name || "").toLowerCase();
    if (name.endsWith(".png")) return "image/png";
    if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
    if (name.endsWith(".gif")) return "image/gif";
    if (name.endsWith(".webp")) return "image/webp";
    if (name.endsWith(".svg")) return "image/svg+xml";
    return "application/octet-stream";
  }

  function inferExtension(file, contentType) {
    const name = String(file?.name || "");
    const dot = name.lastIndexOf(".");
    if (dot > 0) return name.slice(dot + 1);
    const ct = contentType || "";
    if (ct.includes("png")) return "png";
    if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
    if (ct.includes("gif")) return "gif";
    if (ct.includes("webp")) return "webp";
    if (ct.includes("svg")) return "svg";
    return "png";
  }

  function ensureImageFile(file) {
    const ct = inferContentType(file);
    if (!ALLOWED_TYPES.has(ct)) {
      throw new Error(`Unsupported image type: ${ct}`);
    }
    if (file.size > MAX_BYTES) {
      throw new Error(`Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB; max 10 MB)`);
    }
    return { contentType: ct, extension: inferExtension(file, ct) };
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async function list(taskId) {
    if (!taskId) return [];
    try {
      const data = await api("GET", `/api/tasks/${encodeURIComponent(taskId)}/images`);
      if (Array.isArray(data?.images)) return data.images;
      if (Array.isArray(data)) return data;
      return [];
    } catch (err) {
      // 404 means the endpoint isn't mounted yet — treat as empty.
      if (/->\s*404/.test(String(err?.message || ""))) return [];
      throw err;
    }
  }

  async function upload(taskId, file, opts = {}) {
    if (!taskId) throw new Error("taskId is required");
    if (!file) throw new Error("file is required");
    const { contentType, extension } = ensureImageFile(file);
    const dataUrl = await readAsDataURL(file);
    const base64 = dataUrlToBase64(dataUrl);
    const body = {
      data: base64,
      contentType,
      filename: String(opts.filename || file.name || `image.${extension}`),
    };
    return api("POST", `/api/tasks/${encodeURIComponent(taskId)}/images`, body);
  }

  async function remove(taskId, name) {
    if (!taskId || !name) return;
    return api("DELETE", `/api/tasks/${encodeURIComponent(taskId)}/images/${encodeURIComponent(name)}`);
  }

  function srcFor(taskId, name) {
    return `/api/tasks/${encodeURIComponent(taskId)}/images/${encodeURIComponent(name)}`;
  }

  function markdownFor(taskId, name) {
    const alt = String(name || "image").replace(/[\[\]]/g, "_");
    return `![${alt}](${srcFor(taskId, name)})`;
  }

  async function copyMarkdown(taskId, name) {
    const text = markdownFor(taskId, name);
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch { /* fall through to legacy path */ }
    }
    // Legacy fallback (older browsers / non-secure contexts).
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
  }

  // ─── Lightbox ──────────────────────────────────────────────────────────────

  function ensureLightbox() {
    let lb = document.getElementById("image-lightbox");
    if (lb) return lb;
    lb = document.createElement("div");
    lb.id = "image-lightbox";
    lb.className = "image-lightbox";
    lb.hidden = true;
    lb.setAttribute("role", "dialog");
    lb.setAttribute("aria-modal", "true");
    lb.setAttribute("aria-label", "Image preview");
    lb.tabIndex = -1;
    lb.append(Object.assign(document.createElement("img"), { className: "image-lightbox-img", alt: "" }));
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "image-lightbox-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", closeLightbox);
    lb.append(closeBtn);
    document.body.append(lb);

    // Click on backdrop (not the image or close button) closes.
    lb.addEventListener("click", (e) => {
      if (e.target === lb) closeLightbox();
    });
    return lb;
  }

  function openLightbox(src, alt) {
    const lb = ensureLightbox();
    const img = lb.querySelector("img.image-lightbox-img");
    img.src = src;
    img.alt = alt || "";
    lb.hidden = false;
    document.body.classList.add("image-lightbox-open");
    // Focus the lightbox so Esc works without a click first.
    try { lb.focus({ preventScroll: true }); } catch { lb.focus(); }
  }

  function closeLightbox() {
    const lb = document.getElementById("image-lightbox");
    if (!lb) return;
    lb.hidden = true;
    const img = lb.querySelector("img.image-lightbox-img");
    if (img) img.removeAttribute("src");
    document.body.classList.remove("image-lightbox-open");
  }

  // Esc closes the lightbox (capture phase so it fires before any local handlers).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const lb = document.getElementById("image-lightbox");
      if (lb && !lb.hidden) {
        e.stopPropagation();
        closeLightbox();
      }
    }
  }, true);

  // ─── Drop-zone wiring (reusable for the task view panel) ───────────────────

  /**
   * Attach drop / dragover / dragleave to a zone element. The callback
   * receives an array of File objects.
   */
  function attachDropZone(zone, onFiles) {
    if (!zone) return () => {};
    const onDragOver = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      zone.classList.add("dragging");
    };
    const onDragLeave = (e) => {
      // Only clear when we leave the zone, not when crossing child elements.
      if (e.target === zone) zone.classList.remove("dragging");
    };
    const onDrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove("dragging");
      const files = collectImageFiles(e.dataTransfer);
      if (files.length > 0) onFiles(files, e);
    };
    zone.addEventListener("dragover", onDragOver);
    zone.addEventListener("dragleave", onDragLeave);
    zone.addEventListener("drop", onDrop);
    return () => {
      zone.removeEventListener("dragover", onDragOver);
      zone.removeEventListener("dragleave", onDragLeave);
      zone.removeEventListener("drop", onDrop);
    };
  }

  function hasFiles(e) {
    if (!e.dataTransfer) return false;
    const types = e.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "Files") return true;
    }
    return false;
  }

  function collectImageFiles(dt) {
    if (!dt?.files) return [];
    const out = [];
    for (const f of dt.files) {
      const ct = inferContentType(f);
      if (ALLOWED_TYPES.has(ct)) out.push(f);
    }
    return out;
  }

  function collectClipboardImages(dt) {
    if (!dt) return [];
    const out = [];
    for (const item of dt.items || []) {
      if (item.kind !== "file") continue;
      if (!item.type || !item.type.startsWith("image/")) continue;
      const f = item.getAsFile();
      if (f) out.push(f);
    }
    return out;
  }

  /**
   * Attach a document-level paste handler that calls onFiles when image
   * files are on the clipboard. Returns a detacher.
   *
   * The handler is conservative: it always preventDefault()s pastes that
   * contain images (so the browser doesn't try to render them in editable
   * regions), but ignores pastes that have no image content.
   */
  function attachPasteHandler(onFiles) {
    const handler = (e) => {
      const files = collectClipboardImages(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      onFiles(files, e);
    };
    document.addEventListener("paste", handler, true);
    return () => document.removeEventListener("paste", handler, true);
  }

  // ─── Expose ────────────────────────────────────────────────────────────────

  window.OpenKanImages = {
    list,
    upload,
    remove,
    srcFor,
    markdownFor,
    copyMarkdown,
    openLightbox,
    closeLightbox,
    attachDropZone,
    attachPasteHandler,
    collectImageFiles,
    collectClipboardImages,
    ALLOWED_TYPES,
    MAX_BYTES,
  };
})();
