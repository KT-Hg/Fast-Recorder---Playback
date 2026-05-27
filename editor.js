/**
 * editor.js — Screenshot editor UI
 * Zoom: canvas expands, viewport scrolls (Ctrl+scroll zooms at cursor).
 * Pan:  Space+drag or middle-mouse drag.
 * Tools: crop, draw, rect, ellipse, arrow, text, blur | transforms | undo/redo
 * Shortcuts: fully customisable, stored in chrome.storage.local
 */
/* === Confirm Modal === */
function showConfirm(msg, onConfirm, { title = 'Confirm', danger = false, okLabel } = {}) {
  const modal = document.getElementById('confirmModal');
  document.getElementById('cmTitle').textContent = title;
  document.getElementById('cmMsg').textContent = msg;
  const okBtn = document.getElementById('cmOk');
  const cancelBtn = document.getElementById('cmCancel');
  okBtn.textContent = okLabel || (danger ? 'Delete' : 'Confirm');
  okBtn.className = danger ? 'danger' : '';
  cancelBtn.style.display = '';
  modal.classList.add('show');
  const close = () => modal.classList.remove('show');
  cancelBtn.onclick = close;
  okBtn.onclick = () => { close(); onConfirm(); };
}

(async () => {

  /* === 1. Shortcut system === */
  const SC_DEFS = [
    // id, label, group
    { id:'toolCrop',    label:'Crop tool',          group:'Tools' },
    { id:'toolDraw',    label:'Freehand draw',       group:'Tools' },
    { id:'toolRect',    label:'Rectangle',           group:'Tools' },
    { id:'toolEllipse', label:'Ellipse',             group:'Tools' },
    { id:'toolArrow',   label:'Arrow',               group:'Tools' },
    { id:'toolText',    label:'Text',                group:'Tools' },
    { id:'toolBlur',    label:'Blur / redact',       group:'Tools' },
    { id:'rotateL',     label:'Rotate 90° left',     group:'Transform' },
    { id:'rotateR',     label:'Rotate 90° right',    group:'Transform' },
    { id:'flipH',       label:'Flip horizontal',     group:'Transform' },
    { id:'flipV',       label:'Flip vertical',       group:'Transform' },
    { id:'undo',        label:'Undo',                group:'Edit' },
    { id:'redo',        label:'Redo',                group:'Edit' },
    { id:'saveCrop',    label:'Crop & Save',         group:'Save' },
    { id:'saveFull',    label:'Quick save (crop or full)', group:'Save' },
    { id:'zoomIn',      label:'Zoom in',             group:'Zoom' },
    { id:'zoomOut',     label:'Zoom out',            group:'Zoom' },
    { id:'zoomReset',   label:'Reset zoom',          group:'Zoom' },
    { id:'help',        label:'Show shortcuts',      group:'Other' },
    { id:'selectAll',   label:'Select all (crop)',    group:'Edit' },
    { id:'copyClip',    label:'Copy to clipboard',    group:'Edit' },
  ];

  // Default shortcuts  (key = e.key value, ctrl/alt are booleans)
  const DEFAULT_SHORTCUTS = {
    toolCrop:    { key:'c',     ctrl:false, alt:false },
    toolDraw:    { key:'d',     ctrl:false, alt:false },
    toolRect:    { key:'r',     ctrl:false, alt:false },
    toolEllipse: { key:'e',     ctrl:false, alt:false },
    toolArrow:   { key:'a',     ctrl:false, alt:false },
    toolText:    { key:'t',     ctrl:false, alt:false },
    toolBlur:    { key:'b',     ctrl:false, alt:false },
    rotateL:     { key:'[',     ctrl:false, alt:false },
    rotateR:     { key:']',     ctrl:false, alt:false },
    flipH:       { key:'h',     ctrl:false, alt:false },
    flipV:       { key:'v',     ctrl:false, alt:false },
    undo:        { key:'z',     ctrl:true,  alt:false },
    redo:        { key:'y',     ctrl:true,  alt:false },
    saveCrop:    { key:'Enter', ctrl:false, alt:false },
    saveFull:    { key:'s',     ctrl:true,  alt:false },
    zoomIn:      { key:'=',     ctrl:true,  alt:false },
    zoomOut:     { key:'-',     ctrl:true,  alt:false },
    zoomReset:   { key:'0',     ctrl:true,  alt:false },
    help:        { key:'?',     ctrl:false, alt:false },
    selectAll:   { key:'a',     ctrl:true,  alt:false },
    copyClip:    { key:'c',     ctrl:true,  alt:false },
  };

  // Active shortcut map (may be overridden from storage)
  let shortcuts = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS));

  // Load saved shortcuts from storage
  await new Promise(resolve => {
    chrome.storage.local.get(['cropEditorShortcuts'], res => {
      if (res.cropEditorShortcuts)
        shortcuts = { ...DEFAULT_SHORTCUTS, ...res.cropEditorShortcuts };
      resolve();
    });
  });

  function saveShortcuts() {
    chrome.storage.local.set({ cropEditorShortcuts: shortcuts });
  }

  function resetShortcutsToDefault() {
    shortcuts = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS));
    saveShortcuts();
  }

  /** Format a shortcut object → display string, e.g. "Ctrl+Z" */
  function fmtSC(sc) {
    if (!sc || !sc.key) return '—';
    const parts = [];
    if (sc.ctrl) parts.push('Ctrl');
    if (sc.alt)  parts.push('Alt');
    const k = sc.key === ' ' ? 'Space' : sc.key;
    parts.push(k.length === 1 ? k.toUpperCase() : k);
    return parts.join('+');
  }

  /** Match a keyboard event against a shortcut definition */
  function matchSC(e, sc) {
    if (!sc || !sc.key) return false;
    const ctrl = !!(e.ctrlKey || e.metaKey);
    const keyMatch = e.key.length === 1
      ? e.key.toLowerCase() === sc.key.toLowerCase()
      : e.key === sc.key;
    return keyMatch && ctrl === !!sc.ctrl && !!e.altKey === !!sc.alt;
  }

  /** Find any SC_DEF (other than excludeId) whose shortcut matches newSc */
  function findConflict(excludeId, newSc) {
    return SC_DEFS.find(d => {
      if (d.id === excludeId || !shortcuts[d.id]?.key) return false;
      const sc = shortcuts[d.id];
      const keyMatch = newSc.key.length === 1
        ? newSc.key.toLowerCase() === sc.key.toLowerCase()
        : newSc.key === sc.key;
      return keyMatch && !!newSc.ctrl === !!sc.ctrl && !!newSc.alt === !!sc.alt;
    });
  }

  /* === 2. Load image === */
  const res = await chrome.runtime.sendMessage({ type: "GET_PENDING_CROP" });
  if (!res?.crop) { window.close(); return; }
  const { dataUrl, downloadPath, saveAs } = res.crop;

  const imgEl = document.getElementById("imgEl");
  await new Promise((resolve, reject) => {
    imgEl.onload = resolve; imgEl.onerror = reject;
    imgEl.src = dataUrl;
  });

  const workCanvas = document.createElement("canvas");
  workCanvas.width  = imgEl.naturalWidth;
  workCanvas.height = imgEl.naturalHeight;
  const workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
  workCtx.drawImage(imgEl, 0, 0);

  /* === 3. Display canvas === */
  const viewport = document.getElementById("viewport");
  const cvs      = document.getElementById("cvs");
  const ctx      = cvs.getContext("2d");

  let fitScale;
  function recalcFit() {
    const maxW = viewport.clientWidth  - 32;
    const maxH = viewport.clientHeight - 16;
    fitScale = Math.min(1, maxW / workCanvas.width, maxH / workCanvas.height);
  }
  recalcFit();

  let zoomLevel = 1.0;
  const MIN_ZOOM = 1.0, MAX_ZOOM = 12;

  function es()      { return fitScale * zoomLevel; }
  function zoomedW() { return Math.round(workCanvas.width  * es()); }
  function zoomedH() { return Math.round(workCanvas.height * es()); }

  function applyCanvasSize() {
    const zW = zoomedW(), zH = zoomedH();
    cvs.width = zW; cvs.height = zH;
    cvs.style.width = zW + "px"; cvs.style.height = zH + "px";
    const w = document.getElementById("wrapper");
    w.style.width = zW + "px"; w.style.height = zH + "px";
    // Switch justify-content so scrollLeft=0 aligns to the true left edge when canvas overflows
    viewport.style.justifyContent = (zW > viewport.clientWidth || zH > viewport.clientHeight) ? "flex-start" : "center";
  }
  applyCanvasSize();

  function toWork(cx, cy) {
    return {
      x: clamp(Math.round(cx / es()), 0, workCanvas.width),
      y: clamp(Math.round(cy / es()), 0, workCanvas.height),
    };
  }
  function toCanv(wx, wy) { return { cx: wx * es(), cy: wy * es() }; }

  function canvasPos(e) {
    const r = cvs.getBoundingClientRect();
    return { cx: clamp(e.clientX-r.left, 0, zoomedW()), cy: clamp(e.clientY-r.top, 0, zoomedH()) };
  }
  function rawCanvasPos(e) {
    const r = cvs.getBoundingClientRect();
    return { cx: e.clientX - r.left, cy: e.clientY - r.top };
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* === 4. Undo / Redo === */
  const undoStack = [], redoStack = [], MAX_UNDO = 20;

  function saveUndo() { undoStack.push(currentSnap()); if (undoStack.length > MAX_UNDO) undoStack.shift(); redoStack.length = 0; syncUR(); }
  function currentSnap() {
    return { w: workCanvas.width, h: workCanvas.height,
             d: workCtx.getImageData(0, 0, workCanvas.width, workCanvas.height) };
  }
  function restoreSnap(snap) {
    const sizeChanged = snap.w !== workCanvas.width || snap.h !== workCanvas.height;
    workCanvas.width = snap.w; workCanvas.height = snap.h;
    workCtx.putImageData(snap.d, 0, 0);
    cropSel = null;
    if (sizeChanged) { recalcFit(); zoomLevel = 1; updateZoomUI(); }
    applyCanvasSize(); render();
  }
  function undo() {
    if(pendingShape) { discardPending(); return; } // Ctrl+Z with a pending shape → discard instead of undoing
    if (!undoStack.length) return;
    redoStack.push(currentSnap()); restoreSnap(undoStack.pop()); syncUR();
  }
  function redo() {
    if(pendingShape) commitPending(); // Commit any pending shape before redoing
    if (!redoStack.length) return;
    undoStack.push(currentSnap()); restoreSnap(redoStack.pop()); syncUR();
  }
  function syncUR() {
    document.getElementById("btnUndo").disabled = !undoStack.length;
    document.getElementById("btnRedo").disabled = !redoStack.length;
  }

  /* === 5. Zoom === */
  function zoomAt(clientX, clientY, factor) {
    const newZ = clamp(zoomLevel * factor, MIN_ZOOM, MAX_ZOOM);
    if (newZ === zoomLevel) return;
    const r = cvs.getBoundingClientRect();
    const wx = (clientX - r.left) / es(), wy = (clientY - r.top) / es();
    zoomLevel = newZ;
    applyCanvasSize(); render(); updateZoomUI();
    const vr = viewport.getBoundingClientRect();
    viewport.scrollLeft = wx * es() - (clientX - vr.left);
    viewport.scrollTop  = wy * es() - (clientY - vr.top);
  }

  function resetZoom() {
    zoomLevel = 1.0; updateZoomUI(); applyCanvasSize(); render();
    viewport.scrollLeft = 0; viewport.scrollTop = 0;
  }

  function updateZoomUI() {
    document.getElementById("zoomLabel").textContent = Math.round(zoomLevel * 100) + "%";
    document.getElementById("btnZoomReset").disabled = zoomLevel === 1.0;
    document.getElementById("btnZoomOut").disabled   = zoomLevel <= MIN_ZOOM;
  }

  /* === 6. Render === */
  function render() {
    const zW = zoomedW(), zH = zoomedH();
    ctx.imageSmoothingEnabled = zoomLevel < 3;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, zW, zH);
    ctx.drawImage(workCanvas, 0, 0, workCanvas.width, workCanvas.height, 0, 0, zW, zH);
    if (isAnnotating && annotStartC && annotPrevC)
      drawShapePreview(ctx, currentTool, annotStartC, annotPrevC, freePoints);
    if (pendingShape) drawPendingHandles();
    if (currentTool === "crop") drawCropOverlay();
  }

  /* === 7. Shape drawing === */
  function drawShapePreview(tCtx, tool, p1c, p2c, fpts, opts = {}) {
    const sw  = opts.strokeWidth ?? strokeWidth;
    const col = opts.color       ?? drawColor;
    const lw  = Math.max(1, sw * es());
    tCtx.save();
    tCtx.strokeStyle = col; tCtx.fillStyle = col;
    tCtx.lineWidth = lw; tCtx.lineCap = "round"; tCtx.lineJoin = "round";

    if (tool === "draw") {
      if (fpts.length < 2) { tCtx.restore(); return; }
      tCtx.beginPath();
      tCtx.moveTo(fpts[0].x * es(), fpts[0].y * es());
      for (let i = 1; i < fpts.length; i++) tCtx.lineTo(fpts[i].x * es(), fpts[i].y * es());
      tCtx.stroke();
    } else if (tool === "rect") {
      const rx = Math.min(p1c.cx,p2c.cx), ry = Math.min(p1c.cy,p2c.cy);
      tCtx.strokeRect(rx, ry, Math.abs(p2c.cx-p1c.cx), Math.abs(p2c.cy-p1c.cy));
    } else if (tool === "ellipse") {
      const cx=(p1c.cx+p2c.cx)/2, cy=(p1c.cy+p2c.cy)/2;
      const rx=Math.abs(p2c.cx-p1c.cx)/2, ry=Math.abs(p2c.cy-p1c.cy)/2;
      if (rx<1||ry<1) { tCtx.restore(); return; }
      tCtx.beginPath(); tCtx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2); tCtx.stroke();
    } else if (tool === "arrow") {
      drawArrow(tCtx, p1c.cx, p1c.cy, p2c.cx, p2c.cy, lw);
    } else if (tool === "blur") {
      tCtx.strokeStyle="#94a3b8"; tCtx.lineWidth=1.5; tCtx.setLineDash([6,3]);
      const bx=Math.min(p1c.cx,p2c.cx), by=Math.min(p1c.cy,p2c.cy);
      tCtx.strokeRect(bx,by,Math.abs(p2c.cx-p1c.cx),Math.abs(p2c.cy-p1c.cy));
      tCtx.setLineDash([]);
    }
    tCtx.restore();
  }

  function commitShape(tool, p1w, p2w, fpts) {
    workCtx.save();
    workCtx.strokeStyle=drawColor; workCtx.fillStyle=drawColor;
    workCtx.lineWidth=strokeWidth; workCtx.lineCap="round"; workCtx.lineJoin="round";
    let drew = true;
    if (tool==="draw") {
      if (fpts.length<2) { drew=false; }
      else { workCtx.beginPath(); workCtx.moveTo(fpts[0].x,fpts[0].y);
             for(let i=1;i<fpts.length;i++) workCtx.lineTo(fpts[i].x,fpts[i].y);
             workCtx.stroke(); }
    } else if (tool==="rect") {
      const rw=Math.abs(p2w.x-p1w.x), rh=Math.abs(p2w.y-p1w.y);
      if (rw<2||rh<2) drew=false;
      else workCtx.strokeRect(Math.min(p1w.x,p2w.x),Math.min(p1w.y,p2w.y),rw,rh);
    } else if (tool==="ellipse") {
      const cx=(p1w.x+p2w.x)/2, cy=(p1w.y+p2w.y)/2;
      const rx=Math.abs(p2w.x-p1w.x)/2, ry=Math.abs(p2w.y-p1w.y)/2;
      if (rx<1||ry<1) drew=false;
      else { workCtx.beginPath(); workCtx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2); workCtx.stroke(); }
    } else if (tool==="arrow") {
      drawArrow(workCtx, p1w.x, p1w.y, p2w.x, p2w.y, strokeWidth);
    } else { drew=false; }
    workCtx.restore();
    return drew;
  }

  function drawArrow(tCtx, x1, y1, x2, y2, lw) {
    const dist=Math.hypot(x2-x1,y2-y1);
    if (dist<2) return;
    const ang=Math.atan2(y2-y1,x2-x1), hl=Math.min(dist*.35,Math.max(lw*5,14));
    tCtx.beginPath(); tCtx.moveTo(x1,y1); tCtx.lineTo(x2,y2); tCtx.stroke();
    tCtx.beginPath();
    tCtx.moveTo(x2,y2);
    tCtx.lineTo(x2-hl*Math.cos(ang-Math.PI/6), y2-hl*Math.sin(ang-Math.PI/6));
    tCtx.lineTo(x2-hl*Math.cos(ang+Math.PI/6), y2-hl*Math.sin(ang+Math.PI/6));
    tCtx.closePath(); tCtx.fill();
  }

  /* === 8. Blur / Text === */
  function applyBlur(p1w, p2w) {
    const x=Math.min(p1w.x,p2w.x), y=Math.min(p1w.y,p2w.y);
    const w=Math.abs(p2w.x-p1w.x), h=Math.abs(p2w.y-p1w.y);
    if (w<4||h<4) return;
    saveUndo();
    // Pixelate-blur: downscale to 1/F then upscale back with smoothing disabled.
    // F=12 gives ~8–10 px blocks at typical screen sizes — readable enough to notice
    // the redaction without leaking detail. Higher values produce coarser blocks.
    const F=12, tmp=document.createElement("canvas");
    tmp.width=Math.max(1,Math.round(w/F)); tmp.height=Math.max(1,Math.round(h/F));
    tmp.getContext("2d").drawImage(workCanvas,x,y,w,h,0,0,tmp.width,tmp.height);
    workCtx.imageSmoothingEnabled=false;
    workCtx.drawImage(tmp,0,0,tmp.width,tmp.height,x,y,w,h);
    workCtx.imageSmoothingEnabled=true;
    render();
  }

  const textInput = document.getElementById("textInput");
  let textPosW = null;

  function showTextInput(cx, cy) {
    textPosW = toWork(cx, cy);
    const fDisp = Math.round(strokeWidth * 7 * es());
    textInput.style.display  = "block";
    textInput.style.left     = cx + "px";
    textInput.style.top      = (cy - fDisp - 4) + "px";
    textInput.style.fontSize = fDisp + "px";
    textInput.style.color    = drawColor;
    textInput.value = "";
    setTimeout(() => textInput.focus(), 0);
  }

  function commitText() {
    const text = textInput.value.trim();
    textInput.style.display = "none";
    if (!text || !textPosW) { textPosW = null; return; }
    saveUndo();
    workCtx.font = `700 ${strokeWidth*7}px system-ui`;
    workCtx.fillStyle = drawColor;
    workCtx.fillText(text, textPosW.x, textPosW.y);
    textPosW = null; render();
  }

  textInput.addEventListener("keydown", e => {
    if (e.key==="Enter")  { e.preventDefault(); commitText(); }
    if (e.key==="Escape") { textInput.style.display="none"; textPosW=null; }
    e.stopPropagation();
  });
  textInput.addEventListener("blur", () => {
    setTimeout(() => {
      if (textInput.style.display !== "block") commitText();
    }, 150);
  });

  /* === 9. Crop overlay === */
  const HVIZ=8, HHIT=14;

  function drawCropOverlay() {
    if (!cropSel) return;
    const {cx:x,cy:y}  = toCanv(cropSel.x, cropSel.y);
    const {cx:x2,cy:y2} = toCanv(cropSel.x+cropSel.w, cropSel.y+cropSel.h);
    const w=x2-x, h=y2-y;
    const zW=zoomedW(), zH=zoomedH();

    ctx.fillStyle="rgba(0,0,0,0.55)";
    ctx.fillRect(0,0,zW,zH);
    ctx.drawImage(workCanvas, cropSel.x, cropSel.y, cropSel.w, cropSel.h, x, y, w, h);

    ctx.strokeStyle="#818cf8"; ctx.lineWidth=2;
    ctx.strokeRect(x+1,y+1,w-2,h-2);

    const hh=Math.floor(HVIZ/2), mx=x+w/2, my=y+h/2;
    [[x-hh,y-hh],[mx-hh,y-hh],[x2-hh,y-hh],
     [x2-hh,my-hh],[x2-hh,y2-hh],[mx-hh,y2-hh],
     [x-hh,y2-hh],[x-hh,my-hh]].forEach(([hx,hy]) => {
      ctx.fillStyle="#fff"; ctx.fillRect(hx,hy,HVIZ,HVIZ);
      ctx.strokeStyle="#4f46e5"; ctx.lineWidth=1.5;
      ctx.strokeRect(hx+.5,hy+.5,HVIZ-1,HVIZ-1);
    });

    const lbl=`${cropSel.w} × ${cropSel.h} px`;
    ctx.font="bold 11px system-ui";
    const tw=ctx.measureText(lbl).width+10;
    const lx=Math.min(x,zW-tw-4), ly=y>20?y-4:y2+14;
    ctx.fillStyle="rgba(79,70,229,0.9)"; ctx.fillRect(lx-2,ly-12,tw,16);
    ctx.fillStyle="#fff"; ctx.fillText(lbl,lx+3,ly);
  }

  function getCropZone(cx, cy) {
    if (!cropSel) return "new";
    const {cx:sx,cy:sy}=toCanv(cropSel.x,cropSel.y);
    const {cx:ex,cy:ey}=toCanv(cropSel.x+cropSel.w,cropSel.y+cropSel.h);
    const r=HHIT/2, mx=(sx+ex)/2, my=(sy+ey)/2;
    const onL=Math.abs(cx-sx)<r, onR=Math.abs(cx-ex)<r;
    const onT=Math.abs(cy-sy)<r, onB=Math.abs(cy-ey)<r;
    const onCX=Math.abs(cx-mx)<r, onCY=Math.abs(cy-my)<r;
    if(onL&&onT)return"nw"; if(onR&&onT)return"ne";
    if(onL&&onB)return"sw"; if(onR&&onB)return"se";
    if(onCX&&onT)return"n"; if(onCX&&onB)return"s";
    if(onL&&onCY)return"w"; if(onR&&onCY)return"e";
    if(cx>=sx&&cx<=ex&&cy>=sy&&cy<=ey)return"move";
    return "new";
  }

  const CROP_CUR={nw:"nw-resize",n:"n-resize",ne:"ne-resize",e:"e-resize",
                  se:"se-resize",s:"s-resize",sw:"sw-resize",w:"w-resize",
                  move:"move",new:"crosshair"};

  /* === 10. State === */
  let currentTool="crop", drawColor="#ef4444", strokeWidth=3;
  let cropSel=null, cropMode="idle", cropHandle=null, cropDragW={};
  let isAnnotating=false, annotStartW=null, annotStartC=null, annotPrevC=null, freePoints=[];
  let isPanning=false, panStart={}, spaceHeld=false;
  const selInfo=document.getElementById("selInfo");

  /* Pending shape — an uncommitted rect/ellipse/arrow that can be repositioned/resized
   * before being baked into workCanvas. Stored with the color/strokeWidth at draw time
   * so later tool-bar changes do not retroactively alter the shape. */
  let pendingShape  = null;   // { tool, p1w, p2w, color, strokeWidth }
  let pendingMode   = "idle"; // "idle" | "move" | "resize"
  let pendingHandle = null;   // which resize handle is being dragged ("nw", "se", "p1", etc.)
  let pendingDragW  = {};     // { startWx, startWy, p1w:{x,y}, p2w:{x,y} }

  /* === 11. Mouse events === */
  cvs.addEventListener("mousemove", e => {
    if (isPanning||isAnnotating||cropMode!=="idle"||pendingMode!=="idle") return;
    if (spaceHeld) { cvs.style.cursor="grab"; return; }
    // Update cursor to reflect the hit zone under the pointer when hovering over a pending shape.
    if (pendingShape) {
      const {cx,cy}=canvasPos(e);
      const pz=getPendingZone(cx,cy);
      if(pz==="move")              { cvs.style.cursor="move"; return; }
      if(pz==="p1"||pz==="p2")    { cvs.style.cursor="crosshair"; return; }
      if(pz)                       { cvs.style.cursor=CROP_CUR[pz]||"crosshair"; return; }
      cvs.style.cursor=TOOL_CURSORS[currentTool]||"crosshair"; return;
    }
    if (currentTool==="crop") {
      const {cx,cy}=canvasPos(e);
      cvs.style.cursor=CROP_CUR[getCropZone(cx,cy)]||"crosshair";
    }
  });
  cvs.addEventListener("mouseleave", () => {
    if (!isPanning&&!isAnnotating&&cropMode==="idle"&&!spaceHeld)
      cvs.style.cursor=TOOL_CURSORS[currentTool]||"crosshair";
  });

  viewport.addEventListener("wheel", e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY<0 ? 1.15 : 1/1.15);
  }, { passive:false });

  cvs.addEventListener("mousedown", e => {
    if (e.button===1) { startPan(e); return; }
    if (e.button!==0) return;
    if (spaceHeld)    { startPan(e); return; }
    const {cx,cy}=canvasPos(e);
    if (currentTool==="text") { if(pendingShape) commitPending(); showTextInput(cx,cy); return; }
    if (currentTool==="crop") {
      if(pendingShape) commitPending();
      const zone=getCropZone(cx,cy);
      if (zone==="new") {
        const sw=toWork(cx,cy); cropSel=null; cropMode="new";
        cropDragW={startWx:sw.x,startWy:sw.y};
        document.getElementById("btnSaveCrop").disabled=true;
        selInfo.textContent="Drag to select…"; render();
      } else if (zone==="move") {
        cropMode="move";
        const wm=toWork(cx,cy);
        cropDragW={startWx:wm.x,startWy:wm.y,ox:cropSel.x,oy:cropSel.y,ww:cropSel.w,wh:cropSel.h};
        cvs.style.cursor="move";
      } else {
        cropMode="resize"; cropHandle=zone;
        const ws=toWork(cx,cy);
        cropDragW={startWx:ws.x,startWy:ws.y,ox:cropSel.x,oy:cropSel.y,ww:cropSel.w,wh:cropSel.h};
        cvs.style.cursor=CROP_CUR[zone];
      }
    } else {
      // If a pending shape exists, check whether the click hits it (move/resize) or falls outside (commit then start new).
      if(pendingShape) {
        const pz=getPendingZone(cx,cy);
        if(pz==="move") {
          pendingMode="move";
          const wm=toWork(cx,cy);
          pendingDragW={startWx:wm.x,startWy:wm.y,p1w:{...pendingShape.p1w},p2w:{...pendingShape.p2w}};
          cvs.style.cursor="move"; return;
        }
        if(pz) {
          // resize handle
          pendingMode="resize"; pendingHandle=pz;
          const wm=toWork(cx,cy);
          pendingDragW={startWx:wm.x,startWy:wm.y,p1w:{...pendingShape.p1w},p2w:{...pendingShape.p2w}};
          cvs.style.cursor=(pz==="p1"||pz==="p2")?"crosshair":(CROP_CUR[pz]||"crosshair"); return;
        }
        // Click outside the pending shape — commit it and start drawing a new one.
        commitPending();
      }
      isAnnotating=true;
      annotStartW=toWork(cx,cy); annotStartC={cx,cy}; annotPrevC={cx,cy};
      freePoints=[{...annotStartW}];
    }
  });

  document.addEventListener("mousemove", e => {
    if (isPanning) { doPan(e); return; }

    // Handle pending-shape drag: either moving the whole shape or resizing via a handle.
    if(pendingMode!=="idle"&&pendingShape) {
      const {cx,cy}=canvasPos(e), wPos=toWork(cx,cy);
      if(pendingMode==="move") {
        const {startWx,startWy,p1w,p2w}=pendingDragW;
        const dx=wPos.x-startWx, dy=wPos.y-startWy;
        pendingShape.p1w={x:p1w.x+dx,y:p1w.y+dy};
        pendingShape.p2w={x:p2w.x+dx,y:p2w.y+dy};
        render(); return;
      }
      if(pendingMode==="resize") {
        const {startWx,startWy,p1w,p2w}=pendingDragW;
        const dx=wPos.x-startWx, dy=wPos.y-startWy;
        if(pendingShape.tool==="arrow") {
          if(pendingHandle==="p1")
            pendingShape.p1w={x:clamp(p1w.x+dx,0,workCanvas.width),y:clamp(p1w.y+dy,0,workCanvas.height)};
          else
            pendingShape.p2w={x:clamp(p2w.x+dx,0,workCanvas.width),y:clamp(p2w.y+dy,0,workCanvas.height)};
        } else {
          // rect/ellipse: resize by moving individual edges of the normalized bounding box.
          let minx=Math.min(p1w.x,p2w.x), maxx=Math.max(p1w.x,p2w.x);
          let miny=Math.min(p1w.y,p2w.y), maxy=Math.max(p1w.y,p2w.y);
          switch(pendingHandle){
            case"nw":minx+=dx;miny+=dy;break; case"ne":maxx+=dx;miny+=dy;break;
            case"sw":minx+=dx;maxy+=dy;break; case"se":maxx+=dx;maxy+=dy;break;
            case"n": miny+=dy;break; case"s": maxy+=dy;break;
            case"w": minx+=dx;break; case"e": maxx+=dx;break;
          }
          minx=clamp(minx,0,workCanvas.width);  miny=clamp(miny,0,workCanvas.height);
          maxx=clamp(maxx,0,workCanvas.width);  maxy=clamp(maxy,0,workCanvas.height);
          if(maxx-minx<2){if("nw sw w".includes(pendingHandle))minx=maxx-2;else maxx=minx+2;}
          if(maxy-miny<2){if("nw ne n".includes(pendingHandle))miny=maxy-2;else maxy=miny+2;}
          pendingShape.p1w={x:minx,y:miny};
          pendingShape.p2w={x:maxx,y:maxy};
        }
        render(); return;
      }
    }

    if (cropMode==="idle"&&!isAnnotating) return;
    const {cx,cy}=canvasPos(e), wPos=toWork(cx,cy);

    if (cropMode==="new") {
      const {startWx,startWy}=cropDragW;
      cropSel=normW({x:startWx,y:startWy,w:wPos.x-startWx,h:wPos.y-startWy});
      const ok=cropSel.w>=2&&cropSel.h>=2;
      document.getElementById("btnSaveCrop").disabled=!ok;
      selInfo.textContent=ok?`${cropSel.w} × ${cropSel.h} px`:"Drag to select…";
      render(); return;
    }
    if (cropMode==="move") {
      const {startWx,startWy,ox,oy,ww,wh}=cropDragW;
      cropSel={x:clamp(ox+(wPos.x-startWx),0,workCanvas.width-ww),
               y:clamp(oy+(wPos.y-startWy),0,workCanvas.height-wh),w:ww,h:wh};
      selInfo.textContent=`${cropSel.w} × ${cropSel.h} px`;
      render(); return;
    }
    if (cropMode==="resize") {
      const {startWx,startWy,ox,oy,ww,wh}=cropDragW;
      const ddx=wPos.x-startWx, ddy=wPos.y-startWy;
      let nx=ox,ny=oy,nw=ww,nh=wh;
      switch(cropHandle){
        case"nw":nx=ox+ddx;ny=oy+ddy;nw=ww-ddx;nh=wh-ddy;break;
        case"ne":          ny=oy+ddy;nw=ww+ddx;nh=wh-ddy;break;
        case"sw":nx=ox+ddx;          nw=ww-ddx;nh=wh+ddy;break;
        case"se":                     nw=ww+ddx;nh=wh+ddy;break;
        case"n":           ny=oy+ddy;           nh=wh-ddy;break;
        case"s":                                nh=wh+ddy;break;
        case"w":nx=ox+ddx;           nw=ww-ddx;           break;
        case"e":                      nw=ww+ddx;           break;
      }
      if(nx<0){nw+=nx;nx=0;} if(ny<0){nh+=ny;ny=0;}
      nw=Math.min(nw,workCanvas.width-nx); nh=Math.min(nh,workCanvas.height-ny);
      if(nw<2){nw=2;if("nw sw w".includes(cropHandle))nx=ox+ww-2;}
      if(nh<2){nh=2;if("nw ne n".includes(cropHandle))ny=oy+wh-2;}
      cropSel={x:nx,y:ny,w:nw,h:nh};
      document.getElementById("btnSaveCrop").disabled=false;
      selInfo.textContent=`${cropSel.w} × ${cropSel.h} px`;
      render(); return;
    }
    if (isAnnotating) {
      annotPrevC={cx,cy};
      if (currentTool==="draw") freePoints.push({...wPos});
      render();
    }
  });

  document.addEventListener("mouseup", e => {
    // Finish a pending-shape drag; reset mode so the next mousedown starts fresh.
    if(pendingMode!=="idle") {
      pendingMode="idle"; pendingHandle=null;
      cvs.style.cursor=TOOL_CURSORS[currentTool]||"crosshair";
      render(); return;
    }
    if (isPanning) {
      isPanning=false;
      cvs.style.cursor=spaceHeld?"grab":(TOOL_CURSORS[currentTool]||"crosshair");
      return;
    }
    const {cx,cy}=canvasPos(e);
    if (cropMode!=="idle") {
      if (cropMode==="new") {
        if (!cropSel||cropSel.w<2||cropSel.h<2) {
          cropSel=null; selInfo.textContent="Drag to select a crop area";
          document.getElementById("btnSaveCrop").disabled=true;
        } else {
          selInfo.textContent=`Selected: ${cropSel.w} × ${cropSel.h} px`;
          document.getElementById("btnSaveCrop").disabled=false;
        }
      } else if (cropSel) {
        selInfo.textContent=`Selected: ${cropSel.w} × ${cropSel.h} px`;
        document.getElementById("btnSaveCrop").disabled=false;
      }
      cropMode="idle"; cropHandle=null; render(); return;
    }
    if (isAnnotating) {
      isAnnotating=false;
      const p2w=toWork(cx,cy);
      if (currentTool==="blur") {
        applyBlur(annotStartW,p2w);
      } else if (currentTool==="draw") {
        // Freehand path: commit immediately — no adjust phase needed.
        saveUndo();
        const drew=commitShape(currentTool,annotStartW,p2w,freePoints);
        if (!drew){undoStack.pop();syncUR();} else render();
      } else if (["rect","ellipse","arrow"].includes(currentTool)) {
        // Keep the shape in pending state so the user can reposition/resize before committing.
        const big = currentTool==="arrow"
          ? Math.hypot(p2w.x-annotStartW.x,p2w.y-annotStartW.y)>=4
          : Math.abs(p2w.x-annotStartW.x)>=2 && Math.abs(p2w.y-annotStartW.y)>=2;
        if(big) {
          pendingShape={tool:currentTool,p1w:{...annotStartW},p2w:{...p2w},
                        color:drawColor,strokeWidth:strokeWidth};
          selInfo.textContent="Drag handles to resize · drag body to move · Esc to discard";
        }
        render();
      } else {
        saveUndo();
        const drew=commitShape(currentTool,annotStartW,p2w,freePoints);
        if (!drew){undoStack.pop();syncUR();} else render();
      }
      annotStartW=annotStartC=annotPrevC=null; freePoints=[];
    }
  });

  /* === 12. Pan === */
  function startPan(e) {
    isPanning=true;
    panStart={clientX:e.clientX,clientY:e.clientY,sl:viewport.scrollLeft,st:viewport.scrollTop};
    cvs.style.cursor="grabbing";
  }
  function doPan(e) {
    viewport.scrollLeft=panStart.sl-(e.clientX-panStart.clientX);
    viewport.scrollTop =panStart.st-(e.clientY-panStart.clientY);
  }

  function normW({x,y,w,h}){return{x:w<0?x+w:x,y:h<0?y+h:y,w:Math.abs(w),h:Math.abs(h)};}

  /* === 12b. Pending shape helpers === */

  /** Returns the shortest distance from point (px, py) to line segment (ax,ay)–(bx,by). */
  function distToSegment(px,py,ax,ay,bx,by) {
    const dx=bx-ax, dy=by-ay, len2=dx*dx+dy*dy;
    if(len2===0) return Math.hypot(px-ax,py-ay);
    const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/len2));
    return Math.hypot(px-ax-t*dx,py-ay-t*dy);
  }

  /**
   * Returns the hit zone of the pending shape at canvas coordinates (cx, cy).
   *   rect/ellipse → "nw"|"n"|"ne"|"e"|"se"|"s"|"sw"|"w"|"move"|null
   *   arrow        → "p1"|"p2"|"move"|null
   */
  function getPendingZone(cx,cy) {
    if(!pendingShape) return null;
    const HHIT_P=14, ps=pendingShape;

    if(ps.tool==="arrow") {
      const p1c=toCanv(ps.p1w.x,ps.p1w.y), p2c=toCanv(ps.p2w.x,ps.p2w.y), r=HHIT_P/2;
      if(Math.hypot(cx-p1c.cx,cy-p1c.cy)<r) return "p1";
      if(Math.hypot(cx-p2c.cx,cy-p2c.cy)<r) return "p2";
      const hitR=Math.max(8, ps.strokeWidth*es()/2+4);
      if(distToSegment(cx,cy,p1c.cx,p1c.cy,p2c.cx,p2c.cy)<hitR) return "move";
      return null;
    }

    // rect / ellipse: bounding box handles
    const norm=normW({x:ps.p1w.x,y:ps.p1w.y,w:ps.p2w.x-ps.p1w.x,h:ps.p2w.y-ps.p1w.y});
    const np1=toCanv(norm.x,norm.y), np2=toCanv(norm.x+norm.w,norm.y+norm.h);
    const sx=np1.cx, sy=np1.cy, ex=np2.cx, ey=np2.cy, r=HHIT_P/2;
    const mx=(sx+ex)/2, my=(sy+ey)/2;
    const onL=Math.abs(cx-sx)<r, onR=Math.abs(cx-ex)<r;
    const onT=Math.abs(cy-sy)<r, onB=Math.abs(cy-ey)<r;
    const onCX=Math.abs(cx-mx)<r, onCY=Math.abs(cy-my)<r;
    if(onL&&onT)return"nw"; if(onR&&onT)return"ne";
    if(onL&&onB)return"sw"; if(onR&&onB)return"se";
    if(onCX&&onT)return"n"; if(onCX&&onB)return"s";
    if(onL&&onCY)return"w"; if(onR&&onCY)return"e";
    if(cx>=sx&&cx<=ex&&cy>=sy&&cy<=ey)return"move";
    return null;
  }

  /** Bake the pending shape into workCanvas, then clear pending state. */
  function commitPending() {
    if(!pendingShape) return;
    const ps=pendingShape;
    pendingShape=null; pendingMode="idle"; pendingHandle=null;
    // Use the color/strokeWidth captured at draw time — toolbar changes made after drawing
    // must not retroactively alter a shape the user is mid-adjusting.
    const savedColor=drawColor, savedWidth=strokeWidth;
    drawColor=ps.color; strokeWidth=ps.strokeWidth;
    saveUndo();
    const drew=commitShape(ps.tool,ps.p1w,ps.p2w,[]);
    if(!drew){undoStack.pop();syncUR();}
    drawColor=savedColor; strokeWidth=savedWidth;
    selInfo.textContent=TOOL_HINTS[currentTool]||"";
    render();
  }

  /** Discard the pending shape without writing it to workCanvas. */
  function discardPending() {
    pendingShape=null; pendingMode="idle"; pendingHandle=null;
    selInfo.textContent=TOOL_HINTS[currentTool]||"";
    render();
  }

  /** Draw the pending shape and its adjustment handles onto the display canvas. */
  function drawPendingHandles() {
    if(!pendingShape) return;
    const ps=pendingShape, HVIZ_P=8;
    const p1c=toCanv(ps.p1w.x,ps.p1w.y), p2c=toCanv(ps.p2w.x,ps.p2w.y);

    // Render with the shape's own color/strokeWidth, not the current toolbar values.
    drawShapePreview(ctx,ps.tool,p1c,p2c,[],{strokeWidth:ps.strokeWidth,color:ps.color});

    ctx.save();
    if(ps.tool==="arrow") {
      // Two square handles at the arrow tail and head.
      [p1c,p2c].forEach(({cx,cy})=>{
        const hh=HVIZ_P/2;
        ctx.fillStyle="#fff"; ctx.fillRect(cx-hh,cy-hh,HVIZ_P,HVIZ_P);
        ctx.strokeStyle="#22c55e"; ctx.lineWidth=1.5; ctx.setLineDash([]);
        ctx.strokeRect(cx-hh+.5,cy-hh+.5,HVIZ_P-1,HVIZ_P-1);
      });
    } else {
      // Eight corner/edge handles around the bounding box, with a green dashed selection outline.
      const norm=normW({x:ps.p1w.x,y:ps.p1w.y,w:ps.p2w.x-ps.p1w.x,h:ps.p2w.y-ps.p1w.y});
      const np1=toCanv(norm.x,norm.y), np2=toCanv(norm.x+norm.w,norm.y+norm.h);
      const sx=np1.cx, sy=np1.cy, ex=np2.cx, ey=np2.cy;
      const mx=(sx+ex)/2, my=(sy+ey)/2, hh=Math.floor(HVIZ_P/2);
      ctx.strokeStyle="#22c55e"; ctx.lineWidth=1; ctx.setLineDash([5,3]);
      ctx.strokeRect(sx,sy,ex-sx,ey-sy);
      ctx.setLineDash([]);
      [[sx-hh,sy-hh],[mx-hh,sy-hh],[ex-hh,sy-hh],
       [ex-hh,my-hh],[ex-hh,ey-hh],[mx-hh,ey-hh],
       [sx-hh,ey-hh],[sx-hh,my-hh]].forEach(([hx,hy])=>{
        ctx.fillStyle="#fff"; ctx.fillRect(hx,hy,HVIZ_P,HVIZ_P);
        ctx.strokeStyle="#22c55e"; ctx.lineWidth=1.5;
        ctx.strokeRect(hx+.5,hy+.5,HVIZ_P-1,HVIZ_P-1);
      });
    }
    ctx.restore();
  }

  /* === 13. Transforms === */
  function rotateWork(deg) {
    if(pendingShape) commitPending();
    saveUndo();
    const w=workCanvas.width, h=workCanvas.height;
    const tmp=document.createElement("canvas");
    const is90=deg===90||deg===-90;
    tmp.width=is90?h:w; tmp.height=is90?w:h;
    const tc=tmp.getContext("2d");
    tc.translate(tmp.width/2,tmp.height/2); tc.rotate(deg*Math.PI/180);
    tc.drawImage(workCanvas,-w/2,-h/2);
    workCanvas.width=tmp.width; workCanvas.height=tmp.height;
    workCtx.drawImage(tmp,0,0);
    cropSel=null; recalcFit(); zoomLevel=1; updateZoomUI();
    applyCanvasSize(); render(); viewport.scrollLeft=0; viewport.scrollTop=0;
  }
  function flipWork(horiz) {
    if(pendingShape) commitPending();
    saveUndo();
    const w=workCanvas.width, h=workCanvas.height;
    const tmp=document.createElement("canvas"); tmp.width=w; tmp.height=h;
    const tc=tmp.getContext("2d");
    if(horiz){tc.translate(w,0);tc.scale(-1,1);}
    else     {tc.translate(0,h);tc.scale(1,-1);}
    tc.drawImage(workCanvas,0,0);
    workCtx.clearRect(0,0,w,h); workCtx.drawImage(tmp,0,0);
    cropSel=null; render();
  }

  /* === 14. Tool wiring === */
  const TOOLS=["crop","draw","rect","ellipse","arrow","text","blur"];
  const TOOL_CURSORS={
    crop:"crosshair",
    draw:"url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22><circle cx=%224%22 cy=%2220%22 r=%223.5%22 fill=%22%23ef4444%22 stroke=%22white%22 stroke-width=%221%22/></svg>') 4 20, crosshair",
    rect:"crosshair",
    ellipse:"crosshair",
    arrow:"crosshair",
    text:"url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22><text x=%222%22 y=%2218%22 font-size=%2218%22 font-weight=%22bold%22 fill=%22%234f46e5%22 stroke=%22white%22 stroke-width=%220.5%22>T</text></svg>') 2 18, text",
    blur:"url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22><rect x=%224%22 y=%224%22 width=%2216%22 height=%2216%22 rx=%222%22 fill=%22none%22 stroke=%22%2394a3b8%22 stroke-width=%221.5%22 stroke-dasharray=%223%22/></svg>') 12 12, crosshair"
  };
  const TOOL_LABELS={crop:"Crop",draw:"Draw",rect:"Rectangle",ellipse:"Ellipse",arrow:"Arrow",text:"Text",blur:"Blur"};
  const TOOL_HINTS={
    crop:"Drag to select a crop area",
    draw:"Drag to draw freehand",
    rect:"Drag to draw a rectangle",
    ellipse:"Drag to draw an ellipse",
    arrow:"Drag to draw an arrow",
    text:"Click to place text",
    blur:"Drag to blur / redact a region",
  };

  // Context bar: show relevant properties per tool
  const contextBar = document.getElementById("contextBar");

  function updateContextBar(tool) {
    let html = '';
    if (tool === "crop") {
      html = '<span class="ctx-hint" id="ctxHint">Drag to select a crop area</span>';
    } else if (tool === "text") {
      html = `<div class="ctx-group"><label>Color</label><input type="color" id="colorPick" value="${drawColor}" /></div>
              <div class="ctx-group"><label>Size</label><select id="strokeSz">
                <option value="2"${strokeWidth===2?' selected':''}>2 px</option>
                <option value="3"${strokeWidth===3?' selected':''}>3 px</option>
                <option value="5"${strokeWidth===5?' selected':''}>5 px</option>
                <option value="8"${strokeWidth===8?' selected':''}>8 px</option>
                <option value="12"${strokeWidth===12?' selected':''}>12 px</option>
              </select></div>
              <span class="ctx-hint" id="ctxHint">Click to place text</span>`;
    } else if (tool === "blur") {
      html = '<span class="ctx-hint" id="ctxHint">Drag to blur / redact a region</span>';
    } else {
      // draw, rect, ellipse, arrow
      html = `<div class="ctx-group"><label>Color</label><input type="color" id="colorPick" value="${drawColor}" /></div>
              <div class="ctx-group"><label>Size</label><select id="strokeSz">
                <option value="2"${strokeWidth===2?' selected':''}>2 px</option>
                <option value="3"${strokeWidth===3?' selected':''}>3 px</option>
                <option value="5"${strokeWidth===5?' selected':''}>5 px</option>
                <option value="8"${strokeWidth===8?' selected':''}>8 px</option>
                <option value="12"${strokeWidth===12?' selected':''}>12 px</option>
              </select></div>
              <span class="ctx-hint" id="ctxHint">${TOOL_HINTS[tool]}</span>`;
    }
    contextBar.innerHTML = html;
    // Re-wire inputs
    const cp = document.getElementById("colorPick");
    if (cp) cp.addEventListener("input", e => {
      drawColor = e.target.value; textInput.style.color = drawColor;
      if(pendingShape){pendingShape.color=drawColor;render();}  // live preview
    });
    const ss = document.getElementById("strokeSz");
    if (ss) ss.addEventListener("change", e => {
      strokeWidth = parseInt(e.target.value, 10);
      if(pendingShape){pendingShape.strokeWidth=strokeWidth;render();}  // live preview
    });
  }

  TOOLS.forEach(id=>{
    const cap=id.charAt(0).toUpperCase()+id.slice(1);
    document.getElementById("tool"+cap).addEventListener("click",()=>setTool(id));
  });

  function showToolToast(name) {
    const el=document.getElementById("toolToast");
    if(!el)return; el.textContent=name; el.classList.remove("show");
    void el.offsetWidth; el.classList.add("show");
  }
  function showSaveToast(msg) {
    const el=document.getElementById("saveToast");
    if(!el)return; el.textContent=msg; el.classList.remove("show");
    void el.offsetWidth; el.classList.add("show");
  }

  function setTool(id) {
    if(pendingShape) commitPending(); // Commit any in-flight shape before switching tools.
    currentTool=id;
    TOOLS.forEach(t=>{
      document.getElementById("tool"+t.charAt(0).toUpperCase()+t.slice(1))
              .classList.toggle("active",t===id);
    });
    cvs.style.cursor=TOOL_CURSORS[id]||"crosshair";
    selInfo.textContent=TOOL_HINTS[id];
    updateContextBar(id);
    render();
    showToolToast(TOOL_LABELS[id]||id);
  }

  document.getElementById("btnZoomIn")   .addEventListener("click",()=>{const vr=viewport.getBoundingClientRect();zoomAt(vr.left+vr.width/2,vr.top+vr.height/2,1.25);});
  document.getElementById("btnZoomOut")  .addEventListener("click",()=>{const vr=viewport.getBoundingClientRect();zoomAt(vr.left+vr.width/2,vr.top+vr.height/2,1/1.25);});
  document.getElementById("btnZoomReset").addEventListener("click",resetZoom);
  document.getElementById("btnRotL") .addEventListener("click",()=>rotateWork(-90));
  document.getElementById("btnRotR") .addEventListener("click",()=>rotateWork(90));
  document.getElementById("btnFlipH").addEventListener("click",()=>flipWork(true));
  document.getElementById("btnFlipV").addEventListener("click",()=>flipWork(false));
  document.getElementById("btnUndo") .addEventListener("click",undo);
  document.getElementById("btnRedo") .addEventListener("click",redo);
  // Color/stroke now wired dynamically via updateContextBar()

  /* === 15. Shortcut panel === */
  const overlay = document.getElementById("shortcutOverlay");
  let scEditMode    = false;  // view vs edit
  let capturingId   = null;   // which sc is being captured
  let conflictLabel = null;   // label of cleared conflict (shown briefly)

  function toggleHelp() {
    scEditMode=false; capturingId=null; conflictLabel=null;
    overlay.classList.toggle("show");
    if (overlay.classList.contains("show")) renderSCPanel();
  }

  function renderSCPanel() {
    const panel = document.getElementById("shortcutPanel");

    // Group definitions
    const groups = {};
    SC_DEFS.forEach(d => { (groups[d.group] ??= []).push(d); });

    const actionsHtml = scEditMode
      ? `<button class="sp-btn danger" id="scReset">Reset defaults</button>
         <button class="sp-btn primary" id="scDone">Done</button>`
      : `<button class="sp-btn" id="scEdit">Edit shortcuts</button>`;

    panel.innerHTML = `
      <div class="sp-header">
        <h2>⌨ Keyboard Shortcuts</h2>
        <div class="sp-actions">
          ${actionsHtml}
          <button class="sp-btn close" id="scClose">✕</button>
        </div>
      </div>
      ${Object.entries(groups).map(([grp,defs]) => `
        <div class="sc-section">
          <h3>${grp}</h3>
          ${defs.map(d => renderRow(d)).join("")}
        </div>
      `).join("")}
    `;

    // Wire header buttons
    document.getElementById("scClose").onclick = () => {
      scEditMode=false; capturingId=null; overlay.classList.remove("show");
      updateToolbarBadges();
    };
    if (scEditMode) {
      document.getElementById("scDone").onclick = () => {
        scEditMode=false; capturingId=null;
        overlay.classList.remove("show"); updateToolbarBadges();
      };
      document.getElementById("scReset").onclick = () => {
        showConfirm("Reset all shortcuts to defaults?", () => {
          resetShortcutsToDefault();
          capturingId=null; conflictLabel=null; renderSCPanel(); updateToolbarBadges();
        }, { title: 'Reset Shortcuts' });
      };
      // Wire capture buttons
      SC_DEFS.forEach(d => {
        const btn = document.getElementById("sc-cap-"+d.id);
        if (btn) btn.onclick = () => {
          capturingId = (capturingId===d.id) ? null : d.id;
          conflictLabel = null;
          renderSCPanel();
        };
        const clr = document.getElementById("sc-clr-"+d.id);
        if (clr) clr.onclick = (e) => {
          e.stopPropagation();
          shortcuts[d.id] = null;
          saveShortcuts();
          if (capturingId===d.id) capturingId=null;
          renderSCPanel(); updateToolbarBadges();
        };
      });
    } else {
      document.getElementById("scEdit").onclick = () => { scEditMode=true; renderSCPanel(); };
    }

    overlay.onclick = e => { if (e.target===overlay) { scEditMode=false; capturingId=null; overlay.classList.remove("show"); updateToolbarBadges(); } };
  }

  function renderRow(d) {
    const sc  = shortcuts[d.id];
    const fmt = sc?.key ? fmtSC(sc) : null;

    if (!scEditMode) {
      const cls = fmt ? "sc-key" : "sc-key none";
      return `<div class="sc-row">
        <span class="sc-label">${d.label}</span>
        <span class="${cls}">${fmt || '—'}</span>
      </div>`;
    }

    // Edit mode
    const isCapturing = capturingId === d.id;
    const capCls = isCapturing ? "sc-capture active" : (fmt ? "sc-capture" : "sc-capture none");
    const capTxt = isCapturing ? "Press key…" : (fmt || "— click to set");
    const conflictHtml = (isCapturing && conflictLabel)
      ? `<div class="sc-conflict">Cleared conflict: ${conflictLabel}</div>` : "";

    return `<div class="sc-row" style="flex-wrap:wrap">
      <span class="sc-label">${d.label}</span>
      <div style="display:flex;gap:4px;align-items:center">
        <button class="${capCls}" id="sc-cap-${d.id}">${capTxt}</button>
        ${fmt ? `<button class="sp-btn" id="sc-clr-${d.id}" title="Clear shortcut" style="padding:3px 7px">✕</button>` : ""}
      </div>
      ${conflictHtml}
    </div>`;
  }

  /** Update sidebar button tooltips to reflect current shortcuts */
  function updateToolbarBadges() {
    const toolIds = ["toolCrop","toolDraw","toolRect","toolEllipse","toolArrow","toolText","toolBlur"];
    toolIds.forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      const toolKey = id.replace("tool","").toLowerCase();
      const sc = fmtSC(shortcuts[id]) || "none";
      btn.dataset.tip = `${TOOL_LABELS[toolKey]||toolKey} (${sc})`;
    });
    const map = {
      btnRotL:"rotateL", btnRotR:"rotateR", btnFlipH:"flipH", btnFlipV:"flipV",
      btnUndo:"undo",    btnRedo:"redo",
      btnSaveCrop:"saveCrop", btnSaveFull:"saveFull",
      btnZoomIn:"zoomIn", btnZoomOut:"zoomOut", btnZoomReset:"zoomReset",
      btnHelp:"help",
    };
    Object.entries(map).forEach(([btnId,scId]) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      const base = (btn.dataset.tip || btn.title || "").split(" (")[0];
      const sc = fmtSC(shortcuts[scId]) || "none";
      if (btn.dataset.tip !== undefined) btn.dataset.tip = `${base} (${sc})`;
      else btn.title = `${base} (${sc})`;
    });
  }

  document.getElementById("btnHelp").addEventListener("click", toggleHelp);

  /* === 16. Keyboard handler === */
  document.addEventListener("keydown", e => {
    if (textInput.style.display === "block") return;

    /* === Shortcut capture mode === */
    if (capturingId !== null) {
      e.preventDefault(); e.stopPropagation();
      if (e.key==="Escape") { capturingId=null; conflictLabel=null; renderSCPanel(); return; }
      if (["Control","Alt","Shift","Meta","CapsLock","Tab"].includes(e.key)) return;

      const newSc = { key: e.key, ctrl: !!(e.ctrlKey||e.metaKey), alt: !!e.altKey };
      const conflict = findConflict(capturingId, newSc);
      if (conflict) {
        shortcuts[conflict.id] = null;
        conflictLabel = conflict.label;
      } else {
        conflictLabel = null;
      }
      shortcuts[capturingId] = newSc;
      capturingId = null;
      saveShortcuts(); renderSCPanel(); updateToolbarBadges();
      return;
    }

    /* === Shortcut panel open (not capturing) === */
    if (overlay.classList.contains("show")) {
      if (e.key==="Escape") {
        e.preventDefault();
        if (scEditMode) { scEditMode=false; renderSCPanel(); }
        else { overlay.classList.remove("show"); updateToolbarBadges(); }
      }
      return;
    }

    /* === Escape: discard pending shape === */
    if (e.key==="Escape" && pendingShape && !isAnnotating && cropMode==="idle") {
      e.preventDefault(); discardPending(); return;
    }

    /* === Space → pan mode === */
    if (e.key===" " && !spaceHeld && !isAnnotating && cropMode==="idle") {
      e.preventDefault(); spaceHeld=true; cvs.style.cursor="grab"; return;
    }

    /* === Ctrl combos (always check, even mid-drag for undo) === */
    if (matchSC(e, shortcuts.undo))      { e.preventDefault(); undo(); return; }
    if (matchSC(e, shortcuts.redo))      { e.preventDefault(); redo(); return; }
    if (matchSC(e, shortcuts.saveFull))  { e.preventDefault(); if (cropSel) document.getElementById("btnSaveCrop").click(); else document.getElementById("btnSaveFull").click(); return; }
    if (matchSC(e, shortcuts.zoomIn))    { e.preventDefault(); const vr=viewport.getBoundingClientRect(); zoomAt(vr.left+vr.width/2,vr.top+vr.height/2,1.25); return; }
    if (matchSC(e, shortcuts.zoomOut))   { e.preventDefault(); const vr=viewport.getBoundingClientRect(); zoomAt(vr.left+vr.width/2,vr.top+vr.height/2,1/1.25); return; }
    if (matchSC(e, shortcuts.zoomReset)) { e.preventDefault(); resetZoom(); return; }
    if (matchSC(e, shortcuts.selectAll)) { e.preventDefault(); selectAllCrop(); return; }
    if (matchSC(e, shortcuts.copyClip))  { e.preventDefault(); copyToClipboard(); return; }
    if (matchSC(e, shortcuts.help))      { e.preventDefault(); toggleHelp(); return; }
    if (matchSC(e, shortcuts.saveCrop) && cropSel) { e.preventDefault(); document.getElementById("btnSaveCrop").click(); return; }

    // Skip bare-key shortcuts during active drag or when modifier held
    if (e.ctrlKey||e.metaKey||e.altKey) return;
    if (isAnnotating||cropMode!=="idle") {
      if (e.key==="Escape") confirmCloseIfDirty();
      return;
    }

    /* === Tool / transform shortcuts === */
    if (matchSC(e, shortcuts.toolCrop))    { setTool("crop"); return; }
    if (matchSC(e, shortcuts.toolDraw))    { setTool("draw"); return; }
    if (matchSC(e, shortcuts.toolRect))    { setTool("rect"); return; }
    if (matchSC(e, shortcuts.toolEllipse)) { setTool("ellipse"); return; }
    if (matchSC(e, shortcuts.toolArrow))   { setTool("arrow"); return; }
    if (matchSC(e, shortcuts.toolText))    { setTool("text"); return; }
    if (matchSC(e, shortcuts.toolBlur))    { setTool("blur"); return; }
    if (matchSC(e, shortcuts.rotateL))     { rotateWork(-90); return; }
    if (matchSC(e, shortcuts.rotateR))     { rotateWork(90); return; }
    if (matchSC(e, shortcuts.flipH))       { flipWork(true); return; }
    if (matchSC(e, shortcuts.flipV))       { flipWork(false); return; }

    if (e.key==="Escape") confirmCloseIfDirty();
  });

  document.addEventListener("keyup", e => {
    if (e.key===" ") {
      spaceHeld=false;
      if (!isPanning) cvs.style.cursor=TOOL_CURSORS[currentTool]||"crosshair";
    }
  });

  /* === 17. Save / Cancel === */
  document.getElementById("btnSaveCrop").addEventListener("click", () => {
    if(pendingShape) commitPending();
    if (!cropSel) return;
    const {x,y,w,h}=cropSel;
    const off=document.createElement("canvas"); off.width=w; off.height=h;
    off.getContext("2d").drawImage(workCanvas,x,y,w,h,0,0,w,h);
    chrome.runtime.sendMessage({type:"SAVE_CROPPED",dataUrl:off.toDataURL("image/png"),downloadPath,saveAs}, (res) => {
      if (res?.success) { showSaveToast(`Saved crop: ${w}×${h} px`); setTimeout(()=>window.close(), 1200); }
    });
  });
  document.getElementById("btnSaveFull").addEventListener("click", () => {
    if(pendingShape) commitPending();
    chrome.runtime.sendMessage({type:"SAVE_CROPPED",dataUrl:workCanvas.toDataURL("image/png"),downloadPath,saveAs}, (res) => {
      if (res?.success) { showSaveToast(`Saved full: ${workCanvas.width}×${workCanvas.height} px`); setTimeout(()=>window.close(), 1200); }
    });
  });
  function confirmCloseIfDirty() {
    if (undoStack.length > 0 || pendingShape) {
      showConfirm("Unsaved changes will be lost. Close?", () => window.close(), {
        title: 'Discard changes?', danger: true, okLabel: 'Close'
      });
    } else {
      window.close();
    }
  }
  document.getElementById("btnCancel").addEventListener("click", confirmCloseIfDirty);

  /* === Select All & Copy to Clipboard === */
  function selectAllCrop() {
    setTool("crop");
    cropSel = { x: 0, y: 0, w: workCanvas.width, h: workCanvas.height };
    document.getElementById("btnSaveCrop").disabled = false;
    selInfo.textContent = `Selected: ${cropSel.w} × ${cropSel.h} px`;
    render();
  }

  async function copyToClipboard() {
    if(pendingShape) commitPending();
    const srcCanvas = (cropSel && cropSel.w >= 2 && cropSel.h >= 2)
      ? (() => {
          const { x, y, w, h } = cropSel;
          const off = document.createElement("canvas"); off.width = w; off.height = h;
          off.getContext("2d").drawImage(workCanvas, x, y, w, h, 0, 0, w, h);
          return off;
        })()
      : workCanvas;

    try {
      const blob = await new Promise(resolve => srcCanvas.toBlob(resolve, "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      selInfo.textContent = "✓ Copied to clipboard!";
      setTimeout(() => { selInfo.textContent = cropSel ? `Selected: ${cropSel.w} × ${cropSel.h} px` : TOOL_HINTS[currentTool]; }, 1500);
    } catch (err) {
      selInfo.textContent = "✕ Copy failed — " + err.message;
    }
  }

  /* === 18. Theme toggle === */
  const btnTheme = document.getElementById("btnTheme");
  function applyTheme(dark) {
    document.body.classList.toggle("light", !dark);
    if (btnTheme) btnTheme.textContent = dark ? "🌙" : "☀️";
  }
  // Sync with popup theme
  chrome.storage.local.get(["theme"], res => {
    applyTheme(res.theme !== "light");
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.theme) applyTheme(changes.theme.newValue !== "light");
  });
  if (btnTheme) btnTheme.addEventListener("click", () => {
    const isLight = document.body.classList.contains("light");
    const newTheme = isLight ? "dark" : "light";
    chrome.storage.local.set({ theme: newTheme });
    applyTheme(newTheme !== "light");
  });

  /* === 19. Init === */
  updateToolbarBadges();
  setTool("crop");

})();
