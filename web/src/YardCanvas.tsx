import { useEffect, useRef, type MouseEvent } from "react";
import { harnessDisplayName } from "./harness";
import type { AgentState, ExecutionGraphState, RunSnapshot } from "./types";
import { childTrackSlots, childTrainScale, childTrainTargetX, childTrainTargetY, executionStations, executionTrainTargetX, partitionYardChildren } from "./yardMotion";

type Hit = { x: number; y: number; w: number; h: number; type: "dog" | "agent" | "tower" | "execution" | "node" | "dock"; id?: string };
type Light = "day" | "night";

const W = 1100;
const H = 680;

export function yardViewport(width: number, height: number): { scale: number; x: number; y: number } {
  const scale = Math.min(width / W, height / H);
  return {
    scale,
    x: (width - W * scale) / 2,
    y: (height - H * scale) / 2,
  };
}

export function YardCanvas({ snapshot, selectedId, executionId, dockFocused = false, onSelect, onSelectNode, onOpenExecution, onOpenDock, light, petNonce, onPet }: {
  snapshot: RunSnapshot;
  selectedId?: string;
  executionId?: string;
  dockFocused?: boolean;
  onSelect: (id: string) => void;
  onSelectNode?: (nodeId: string) => void;
  onOpenExecution?: (id: string) => void;
  onOpenDock?: () => void;
  light: Light;
  petNonce: number;
  onPet: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitsRef = useRef<Hit[]>([]);
  const startRef = useRef(performance.now());
  const petAtRef = useRef(0);
  const petNonceRef = useRef(petNonce);
  const motionRef = useRef(new Map<string, { x: number; y: number }>());
  const frameAtRef = useRef(performance.now());

  useEffect(() => {
    if (petNonce !== petNonceRef.current) petAtRef.current = performance.now();
    petNonceRef.current = petNonce;
  }, [petNonce]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const dog = load("/assets/watchdog-sprites.png");
    const trains = load("/assets/train-sprites.png");
    const backdrop = load("/assets/yard-backdrop.png");
    const tower = load("/assets/signal-tower-v2.png");
    const tracks = load("/assets/track-atlas.png");
    const clouds = load("/assets/cloud-atlas.png");
    const smoke = load("/assets/smoke-sprites.png");
    const dock = load("/assets/agent-dock-v1.png");
    let frame = 0;

    const render = (now: number) => {
      // Queue the next frame first so one transient draw failure cannot freeze
      // the entire Yard until the page is reloaded.
      frame = requestAnimationFrame(render);
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
        canvas.width = Math.floor(rect.width * dpr); canvas.height = Math.floor(rect.height * dpr);
      }
      const viewport = yardViewport(canvas.width, canvas.height);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = false;
      context.setTransform(viewport.scale, 0, 0, viewport.scale, viewport.x, viewport.y);
      const delta = Math.min(.08, Math.max(0, (now - frameAtRef.current) / 1000));
      frameAtRef.current = now;
      const petElapsed = petAtRef.current ? Math.max(0, (now - petAtRef.current) / 1000) : 99;
      const execution = executionId ? snapshot.executions.find((candidate) => candidate.id === executionId) : undefined;
      hitsRef.current = drawYard(context, snapshot, selectedId, execution, dockFocused, light, (now - startRef.current) / 1000, petElapsed, dog, trains, backdrop, tower, tracks, clouds, smoke, dock, motionRef.current, delta);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [snapshot, selectedId, executionId, dockFocused, light]);

  const locateHit = (event: MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const viewport = yardViewport(rect.width, rect.height);
    const x = (event.clientX - rect.left - viewport.x) / viewport.scale;
    const y = (event.clientY - rect.top - viewport.y) / viewport.scale;
    if (x < 0 || x > W || y < 0 || y > H) return undefined;
    return [...hitsRef.current].reverse().find((item) => x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h);
  };

  return <canvas ref={canvasRef} width={W} height={H} className="yard-canvas" aria-label="Interactive pixel-art rail yard" onMouseMove={(event) => {
    event.currentTarget.style.cursor = locateHit(event) ? "pointer" : "default";
  }} onMouseLeave={(event) => { event.currentTarget.style.cursor = "default"; }} onClick={(event) => {
    const hit = locateHit(event);
    if (hit?.type === "dog") onPet();
    else if (hit?.type === "dock") onOpenDock?.();
    else if (hit?.type === "execution" && hit.id) onOpenExecution?.(hit.id);
    else if (hit?.type === "node" && hit.id) onSelectNode?.(hit.id);
    else if (hit?.type === "tower") {
      const execution = executionId ? snapshot.executions.find((candidate) => candidate.id === executionId) : undefined;
      const owner = snapshot.agents.find((agent) => agent.threadId === execution?.ownerThreadId)
        ?? snapshot.agents.find((agent) => !agent.parentThreadId);
      if (owner) onSelect(owner.threadId);
    }
    else if (hit?.id) onSelect(hit.id);
  }} />;
}

function drawYard(ctx: CanvasRenderingContext2D, snapshot: RunSnapshot, selectedId: string | undefined, execution: ExecutionGraphState | undefined, dockFocused: boolean, light: Light, t: number, petT: number, dog: HTMLImageElement, trains: HTMLImageElement, backdrop: HTMLImageElement, tower: HTMLImageElement, tracks: HTMLImageElement, clouds: HTMLImageElement, smoke: HTMLImageElement, dock: HTMLImageElement, motion: Map<string, { x: number; y: number }>, delta: number): Hit[] {
  const night = light === "night";
  ctx.fillStyle = night ? "#142b27" : "#547c48";
  ctx.fillRect(0, 0, W, H);
  if (backdrop.complete && backdrop.naturalWidth) { ctx.globalAlpha = night ? .26 : .38; ctx.drawImage(backdrop, 0, 0, W, H); ctx.globalAlpha = 1; }
  drawTerrain(ctx, night);
  drawClouds(ctx, clouds, night, t);
  if (night) { ctx.fillStyle="rgba(6,16,32,.28)"; ctx.fillRect(0,0,W,H); }
  const primaryRoot = snapshot.agents.find((agent) => agent.threadId === execution?.ownerThreadId)
    ?? snapshot.agents.find((agent) => !agent.parentThreadId);
  const children = primaryRoot
    ? snapshot.agents.filter((agent) => agent.parentThreadId === primaryRoot.threadId)
    : snapshot.agents.filter((agent) => agent.parentThreadId);
  const yardChildren = partitionYardChildren(children);
  const placements = layoutChildren(yardChildren.visible);
  const carriageScale = childTrainScale(yardChildren.visible.length);
  drawTracks(ctx, tracks, placements, night);

  const hits: Hit[] = [];
  hits.push(...drawStations(ctx, execution, primaryRoot, night));
  drawTower(ctx, tower, night, selectedId === primaryRoot?.threadId);
  const dogY = 137;
  drawDog(ctx, dog, 104, dogY, t, snapshot, petT);
  drawHarnessSign(ctx, snapshot.adapter, night);
  hits.push({ x: 18, y: 34, w: 280, h: 305, type: "tower" }, { x: 98, y: 128, w: 104, h: 108, type: "dog" });
  if (yardChildren.dockEnabled) {
    const dockSelected = dockFocused || yardChildren.docked.some((agent) => agent.threadId === selectedId);
    drawDock(ctx, dock, yardChildren.docked.length, night, dockSelected);
    hits.push({ x: DOCK_X - 6, y: DOCK_Y - 6, w: DOCK_W + 12, h: DOCK_LABEL_Y + DOCK_LABEL_H - DOCK_Y + 6, type: "dock" });
  }

  const roots = primaryRoot ? [primaryRoot] : [];
  roots.forEach((agent, index) => {
    const targetX = executionTrainTargetX(execution, Boolean(agent.activeTurnId), agent.status) + index * 28;
    const { x, y } = easedPosition(motion, agent.threadId, targetX, MAIN_LINE_Y, delta);
    drawTrain(ctx, trains, smoke, agent, x, y, 0, selectedId === agent.threadId, t, 1, true);
    hits.push(trainHit(agent.threadId, x, y, 1));
  });

  placements.forEach(({ agent, x: baseX, y: baseY, variant }, index) => {
    const targetX = childTrainTargetX(baseX, Boolean(agent.activeTurnId), agent.latestActivity?.status);
    const targetY = childTrainTargetY(
      baseY,
      Boolean(agent.activeTurnId),
      agent.status,
      agent.latestActivity?.status,
      MAIN_LINE_Y,
      carriageScale,
    );
    const position = easedPosition(motion, agent.threadId, targetX, targetY, delta);
    drawTrain(ctx, trains, smoke, agent, position.x, position.y, variant, selectedId === agent.threadId, t + index * .17, carriageScale);
    hits.push(trainHit(agent.threadId, position.x, position.y, carriageScale));
  });

  if (night) drawFireflies(ctx, t);
  return hits;
}

const DOCK_X = 32;
const DOCK_Y = 476;
const DOCK_W = 191;
const DOCK_H = 152;
const DOCK_LABEL_Y = 629;
const DOCK_LABEL_H = 27;

function drawDock(ctx: CanvasRenderingContext2D, image: HTMLImageElement, count: number, night: boolean, selected: boolean) {
  if (selected) {
    ctx.fillStyle = "#f2bf4f";
    ctx.fillRect(DOCK_X - 4, DOCK_Y - 4, 48, 4);
    ctx.fillRect(DOCK_X - 4, DOCK_Y - 4, 4, 38);
    ctx.fillRect(DOCK_X + DOCK_W - 44, DOCK_Y - 4, 48, 4);
    ctx.fillRect(DOCK_X + DOCK_W, DOCK_Y - 4, 4, 38);
  }
  if (image.complete && image.naturalWidth) {
    ctx.save();
    ctx.globalAlpha = night ? .82 : 1;
    ctx.drawImage(image, DOCK_X, DOCK_Y, DOCK_W, DOCK_H);
    ctx.restore();
  } else {
    ctx.fillStyle = night ? "#1b2a24" : "#503920";
    ctx.fillRect(DOCK_X + 18, DOCK_Y + 35, DOCK_W - 36, DOCK_H - 45);
  }
  ctx.fillStyle = "#111915";
  ctx.fillRect(DOCK_X + 1, DOCK_LABEL_Y, DOCK_W - 2, DOCK_LABEL_H);
  ctx.strokeStyle = count > 0 ? "#b59448" : "#35433b";
  ctx.lineWidth = 1;
  ctx.strokeRect(DOCK_X + 2, DOCK_LABEL_Y + 1, DOCK_W - 4, DOCK_LABEL_H - 2);
  ctx.fillStyle = count > 0 ? "#f3eedf" : "#89958d";
  ctx.font = "700 11px ui-monospace";
  ctx.textAlign = "center";
  ctx.fillText(count > 0 ? `DOCK · ${count}` : "DOCK · EMPTY", DOCK_X + DOCK_W / 2, DOCK_LABEL_Y + 18);
}

function drawHarnessSign(ctx: CanvasRenderingContext2D, adapter: RunSnapshot["adapter"], night: boolean) {
  const x = 824;
  const y = 44;
  const width = 238;
  const height = 48;
  ctx.fillStyle = night ? "rgba(9,17,19,.9)" : "rgba(29,43,32,.9)";
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = night ? "#637a70" : "#344d39";
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, width - 2, height - 2);
  ctx.fillStyle = adapter ? "#62d18b" : "#89958d";
  ctx.fillRect(x + 13, y + 14, 8, 8);
  ctx.font = "700 12px ui-monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = night ? "#e4ece7" : "#f0eadc";
  ctx.fillText(adapter ? `WATCHING ${harnessDisplayName(adapter)}` : "WATCHDOG STANDBY", x + 30, y + 23);
  ctx.font = "700 7px ui-monospace";
  ctx.fillStyle = night ? "#758980" : "#95a391";
  ctx.fillText(adapter?.transport.toUpperCase() ?? "NO RUNTIME CONNECTED", x + 30, y + 36);
}

function easedPosition(motion: Map<string, { x: number; y: number }>, id: string, targetX: number, targetY: number, delta: number): { x: number; y: number } {
  const current = motion.get(id) ?? { x: targetX, y: targetY };
  const amount = 1 - Math.exp(-delta * 5.5);
  current.x += (targetX - current.x) * amount;
  current.y += (targetY - current.y) * amount;
  if (Math.abs(targetX - current.x) < .1) current.x = targetX;
  if (Math.abs(targetY - current.y) < .1) current.y = targetY;
  motion.set(id, current);
  return current;
}

const MAIN_LINE_Y = 410;
type Placement = { agent: AgentState; x: number; y: number; variant: number };

function layoutChildren(children: AgentState[]): Placement[] {
  const slots = childTrackSlots(children.length);
  return children.map((agent, index) => ({ agent, ...slots[index]!, variant: trainVariant(agent, index) }));
}

function trainVariant(agent: AgentState, index: number): number {
  const role = agent.role?.toLowerCase() ?? "";
  if (/research|investigat|explor/.test(role)) return 1;
  if (/verif|test|qa/.test(role)) return 2;
  if (/review|audit|critic/.test(role)) return 3;
  let hash = index;
  for (const char of `${agent.threadId}:${role}`) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return 1 + Math.abs(hash % 3);
}

function drawTerrain(ctx: CanvasRenderingContext2D, night: boolean) {
  const tufts = [[300,90],[366,156],[920,82],[1012,170],[270,570],[952,590],[520,90],[760,112],[1000,430],[350,340],[78,555]];
  ctx.fillStyle = night ? "#24483d" : "#659052";
  for (const [x,y] of tufts) { ctx.fillRect(x!,y!,4,13); ctx.fillRect(x!+7,y!+3,4,10); ctx.fillRect(x!+14,y!,4,13); }
  ctx.fillStyle = night ? "#31544b" : "#7a9b63";
  for (let i=0;i<42;i++) { const x=(i*83+37)%W, y=(i*137+51)%H; ctx.fillRect(x,y,3,3); }
  ctx.fillStyle = night ? "#203d38" : "#426b3f";
  [[1010,88],[300,610],[940,170],[274,112]].forEach(([x,y]) => { ctx.fillRect(x!,y!,28,24); ctx.fillRect(x!+5,y!-7,18,35); });
}

function drawTracks(ctx: CanvasRenderingContext2D, image: HTMLImageElement, placements: Placement[], night: boolean) {
  if (!image.complete || !image.naturalWidth) {
    ctx.fillStyle = night ? "#70756d" : "#776e5d";
    ctx.fillRect(260, MAIN_LINE_Y - 4, 765, 8);
    return;
  }
  ctx.save();
  ctx.globalAlpha = night ? .62 : .9;
  drawHorizontalRail(ctx, image, 255, 1035, MAIN_LINE_Y);
  const spurs = new Map<number, { start: number; end: number }>();
  placements.forEach(({ x, y }) => {
    const key = Math.round(x);
    const current = spurs.get(key);
    spurs.set(key, {
      start: Math.min(current?.start ?? MAIN_LINE_Y, y, MAIN_LINE_Y),
      end: Math.max(current?.end ?? MAIN_LINE_Y, y, MAIN_LINE_Y),
    });
  });
  spurs.forEach(({ start, end }, x) => {
    drawVerticalRail(ctx, image, x, start, end);
    drawTrackSprite(ctx, image, 2, 1, x - 40, MAIN_LINE_Y - 39, 80, 80);
  });
  ctx.restore();
}

function drawHorizontalRail(ctx: CanvasRenderingContext2D, image: HTMLImageElement, start: number, end: number, y: number) {
  for (let x = start; x < end; x += 91) drawTrackSprite(ctx, image, 0, 0, x, y - 28, 98, 56);
}

function drawVerticalRail(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, start: number, end: number) {
  for (let y = start; y < end; y += 91) drawTrackSprite(ctx, image, 1, 0, x - 26, y, 52, 99);
}

function drawTrackSprite(ctx: CanvasRenderingContext2D, image: HTMLImageElement, col: number, row: number, x: number, y: number, maxW: number, maxH: number) {
  drawAtlasSprite(ctx, image, 4, 3, col, row, TRACK_BOUNDS[row]![col]!, x, y, maxW, maxH);
}

function drawStations(ctx: CanvasRenderingContext2D, execution: ExecutionGraphState | undefined, root: AgentState | undefined, night: boolean): Hit[] {
  const stations = executionStations(execution);
  const activeIndex = execution
    ? Math.max(-1, stations.findIndex((station) => execution.activeNodeIds.includes(station.id)))
    : !root ? -1 : root.activeTurnId ? 0 : root.status === "unknown" ? 0 : 1;
  const hits: Hit[] = [];
  stations.forEach((station, i) => {
    const active = activeIndex === i || station.status === "running" || station.status === "waiting";
    const failed = station.status === "failed" || station.status === "stopped";
    const width = Math.max(62, Math.min(90, 680 / Math.max(2, stations.length)));
    ctx.fillStyle = night ? "#17231f" : "#e4d9bd"; ctx.fillRect(station.x-width/2, 313, width, 35);
    ctx.fillStyle = failed ? "#c65c51" : active ? "#f6c453" : station.status === "passed" ? "#62b97d" : (night ? "#8ea69b" : "#4d5b4a");
    ctx.fillRect(station.x-width/2+6, 320, width-12, 5);
    ctx.fillStyle = night ? "#d9e5dc" : "#273229";
    ctx.font = `700 ${stations.length > 7 ? 8 : 10}px ui-monospace`;
    ctx.textAlign="center";
    ctx.fillText(truncateStation(station.label, stations.length > 7 ? 10 : 13), station.x, 341);
    ctx.fillStyle = failed ? "#c65c51" : active ? "#ffcc55" : "#294238"; ctx.fillRect(station.x-4, 292, 8, 16);
    if (station.subgraphId) {
      ctx.strokeStyle = active ? "#ffcc55" : night ? "#d9e5dc" : "#294238";
      ctx.lineWidth = 2;
      ctx.strokeRect(station.x + width / 2 - 14, 329, 7, 7);
      hits.push({ x: station.x - width / 2, y: 292, w: width, h: 56, type: "execution", id: station.subgraphId });
    } else hits.push({ x: station.x - width / 2, y: 292, w: width, h: 56, type: "node", id: station.id });
  });
  return hits;
}

function truncateStation(label: string, limit: number): string {
  const normalized = label.trim().toUpperCase();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(1, limit - 1))}…` : normalized;
}

function drawTower(ctx: CanvasRenderingContext2D, image: HTMLImageElement, night: boolean, selected: boolean) {
  if (selected) {
    ctx.fillStyle = "#f2bf4f";
    ctx.fillRect(12, 29, 62, 4); ctx.fillRect(12, 29, 4, 44);
    ctx.fillRect(240, 29, 62, 4); ctx.fillRect(298, 29, 4, 44);
    ctx.fillRect(12, 301, 4, 44); ctx.fillRect(12, 341, 62, 4);
    ctx.fillRect(298, 301, 4, 44); ctx.fillRect(240, 341, 62, 4);
  }
  if (image.complete && image.naturalWidth) {
    ctx.save();
    ctx.globalAlpha = night ? .82 : 1;
    drawAtlasSprite(ctx, image, 1, 1, 0, 0, TOWER_BOUNDS, 18, 34, 280, 305);
    ctx.restore();
    return;
  }
  ctx.fillStyle = night ? "#263b34" : "#6f4d2c";
  ctx.fillRect(55, 70, 205, 180);
  ctx.clearRect(94, 120, 120, 92);
}

function drawDog(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, t: number, snapshot: RunSnapshot, petT: number) {
  const severe = snapshot.loops.some((loop) => loop.warnings.some((warning) => /runaway|stalled|failed|budget|blocked/i.test(warning)))
    || snapshot.executions.some((execution) =>
      ["blocked", "failed"].includes(execution.status)
      || execution.warnings.some((warning) => /runaway|stalled|failed|budget|blocked/i.test(warning)),
    );
  const petElapsed = Math.max(0, petT);
  const petting = petElapsed < .9;
  const row = petting ? 2 : severe ? 3 : snapshot.agents.some((agent) => agent.activeTurnId) ? 1 : 0;
  if (image.complete && image.naturalWidth) {
    const cols=4, rows=4;
    const col=petting ? dogPetFrame(petElapsed) : Math.floor(t*1.5)%4;
    const bounds = DOG_BOUNDS[row]![col]!;
    drawDogSprite(ctx,image,cols,rows,col,row,bounds,x+46,y+92,.36);
  } else {
    ctx.font="64px serif"; ctx.textAlign="left"; ctx.fillText("🐕",x+8,y+68);
  }
  if (snapshot.agents.length === 0 && !petting) drawPixelQuestion(ctx, x + 76, y + 10 + Math.sin(t * 2) * 2);
  if (petting) {
    for (let i=0;i<3;i++) { const p=Math.max(0,petElapsed-i*.12); ctx.fillStyle=i===1?"#f4eee0":"#ffffff"; pixelHeart(ctx,x+23+i*22,y+13-i*3-p*62,.68-p*.08); }
  }
}

export function dogPetFrame(petElapsed: number): number {
  return Math.min(3, Math.max(0, Math.floor(Math.max(0, petElapsed) / .9 * 4)));
}

function drawPixelQuestion(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const rows = ["1110", "0010", "0110", "0100", "0000", "0100"];
  ctx.save();
  ctx.fillStyle = "#f2bf4f";
  rows.forEach((row, rowIndex) => [...row].forEach((value, columnIndex) => {
    if (value === "1") ctx.fillRect(x + columnIndex * 4, y + rowIndex * 4, 4, 4);
  }));
  ctx.restore();
}

function drawDogSprite(ctx: CanvasRenderingContext2D,image:HTMLImageElement,cols:number,rows:number,col:number,row:number,bounds:Bounds,centerX:number,feetY:number,scale:number) {
  const cellW=image.naturalWidth/cols,cellH=image.naturalHeight/rows;
  const [left,top,right,bottom]=bounds;
  const sourceW=right-left,sourceH=bottom-top;
  const width=sourceW*scale,height=sourceH*scale;
  ctx.drawImage(image,col*cellW+left,row*cellH+top,sourceW,sourceH,centerX-width/2,feetY-height,width,height);
}

function pixelHeart(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  const rows=["0110110","1111111","1111111","0111110","0011100","0001000"];
  ctx.save(); ctx.translate(x,y); ctx.scale(s,s);
  rows.forEach((row,ry)=>[...row].forEach((value,rx)=>{if(value==="1")ctx.fillRect(rx*3,ry*3,3,3);}));
  ctx.restore();
}

function drawTrain(ctx: CanvasRenderingContext2D, image: HTMLImageElement, smoke: HTMLImageElement, agent: AgentState, x: number, y: number, variant: number, selected: boolean, t: number, scale = 1, flip = false) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  if (selected) {
    // The right-facing root sprite is mirrored around x=0, moving its visual
    // center from +12 to -12. Keep the selection brackets centered on it.
    const selectionX = flip ? -24 : 0;
    ctx.fillStyle="#f3c64f";
    ctx.fillRect(-52 + selectionX,-49,126,4);
    ctx.fillRect(-56 + selectionX,-45,4,78);
    ctx.fillRect(74 + selectionX,-45,4,78);
  }
  // Anchors are measured from each cropped livery's actual chimney, rather
  // than the visual center of the train body.
  const chimney = [{ x: -1, y: -30 }, { x: -9, y: -35 }, { x: 16, y: -40 }, { x: 9, y: -41 }][variant % 4]!;
  ctx.save();
  if (flip) ctx.scale(-1, 1);
  if (agent.activeTurnId) drawSmoke(ctx, smoke, chimney.x, chimney.y, t, agent.threadId);
  if (image.complete && image.naturalWidth) {
    // This row has a chimney on every livery. Its baked smoke is cropped away,
    // leaving the separate animated smoke layer as the only smoke.
    const cols=4,rows=2,row=0,col=variant%4;
    drawAtlasSprite(ctx,image,cols,rows,col,row,TRAIN_BOUNDS[row]![col]!,-48,-46,120,90);
  } else {
    ctx.fillStyle=variant===0?"#d95b43":["#5f9ec5","#d3a34a","#7d6eb2"][variant-1]??"#5f9ec5"; ctx.fillRect(-27,-22,62,30); ctx.fillRect(-15,-38,28,18); ctx.fillStyle="#1f2925"; ctx.fillRect(-20,8,14,14);ctx.fillRect(22,8,14,14);
  }
  ctx.restore();
  const nameplateX = flip ? -24 : 0;
  const stopped = agent.status === "stopped";
  ctx.fillStyle=stopped?"#2a1413":"#111915"; ctx.fillRect(-48 + nameplateX,38,120,25);
  if (stopped) {
    ctx.strokeStyle="#c65c51"; ctx.lineWidth=2; ctx.strokeRect(-47 + nameplateX,39,118,23);
    ctx.fillStyle="#c65c51"; ctx.fillRect(55 + nameplateX,-40,14,14);
    ctx.fillStyle="#2a1413"; ctx.fillRect(58 + nameplateX,-37,8,8);
    ctx.fillStyle="#c65c51"; ctx.fillRect(60 + nameplateX,-35,4,4);
  }
  ctx.fillStyle=stopped?"#efaaa4":"#f3eedf"; ctx.font="700 12px ui-monospace"; ctx.textAlign="center"; ctx.fillText(agent.nickname??(agent.parentThreadId?agent.threadId.slice(0,8):"ROOT"),12 + nameplateX,55);
  ctx.restore();
}

function drawSmoke(ctx: CanvasRenderingContext2D, image: HTMLImageElement, anchorX: number, anchorY: number, t: number, id: string) {
  if (!image.complete || !image.naturalWidth) return;
  const offset = stableHash(id) % 19 / 7;
  const cycle = (t + offset) % 4.8;
  if (cycle >= 3.6) return;
  const frame = Math.min(3, Math.floor(cycle / .9));
  drawAtlasSprite(ctx, image, 4, 1, frame, 0, SMOKE_BOUNDS[0]![frame]!, anchorX - 24, anchorY - 64, 48, 64);
}

function trainHit(id: string, x: number, y: number, scale: number): Hit {
  return { x: x - 60 * scale, y: y - 50 * scale, w: 132 * scale, h: 116 * scale, type: "agent", id };
}

function stableHash(value: string): number { let hash=0; for (const char of value) hash=(hash*31+char.charCodeAt(0))|0; return Math.abs(hash); }

function drawClouds(ctx: CanvasRenderingContext2D, image: HTMLImageElement, night: boolean, t: number) {
  if (!image.complete || !image.naturalWidth) return;
  const clouds = [
    { col: 0, x: ((t * 7 + 70) % 1420) - 210, y: 62, w: 125, h: 75 },
    { col: 1, x: ((t * 4.5 + 560) % 1510) - 260, y: 28, w: 185, h: 105 },
    { col: 2, x: ((t * 8.5 + 1040) % 1540) - 280, y: 138, w: 220, h: 72 },
  ];
  ctx.save();
  ctx.globalAlpha = night ? .2 : .42;
  clouds.forEach((cloud) => drawAtlasSprite(ctx, image, 3, 1, cloud.col, 0, CLOUD_BOUNDS[0]![cloud.col]!, cloud.x, cloud.y, cloud.w, cloud.h));
  ctx.restore();
}
function drawFireflies(ctx: CanvasRenderingContext2D, t: number) { ctx.fillStyle="#e9ce63"; for(let i=0;i<16;i++){const x=(i*97+Math.sin(t+i)*13)%W,y=80+(i*71)%510;ctx.globalAlpha=.3+.7*Math.abs(Math.sin(t*1.7+i));ctx.fillRect(x,y,3,3);}ctx.globalAlpha=1; }
function load(src:string){const image=new Image();image.src=src;return image;}

type Bounds = [number,number,number,number];
const TRAIN_BOUNDS: Bounds[][] = [
  [[29,280,314,510],[98,280,345,509],[45,280,305,510],[42,280,284,510]],
  [[29,99,314,327],[98,118,345,326],[0,126,305,327],[15,122,284,327]],
];
const DOG_BOUNDS: Bounds[][] = [
  [[112,39,275,304],[85,39,260,304],[50,33,239,304],[37,33,225,304]],
  [[60,29,308,285],[57,31,274,286],[14,30,219,285],[31,31,239,286]],
  [[77,10,294,263],[65,20,280,264],[61,10,271,266],[50,16,241,266]],
  [[98,0,283,250],[54,16,260,250],[41,0,262,250],[37,0,241,250]],
];
const TRACK_BOUNDS: Bounds[][] = [
  [[34,170,305,324],[79,83,237,384],[16,80,270,349],[39,83,289,349]],
  [[27,91,276,346],[41,92,289,346],[2,65,301,350],[22,65,281,350]],
  [[20,98,314,292],[0,106,271,251],[13,63,288,313],[24,50,282,312]],
];
const CLOUD_BOUNDS: Bounds[][] = [
  [[185,264,531,491],[46,193,594,524],[9,287,647,484]],
];
const SMOKE_BOUNDS: Bounds[][] = [
  [[212,454,359,628],[177,292,336,628],[122,131,417,628],[86,106,407,628]],
];
const TOWER_BOUNDS: Bounds = [103,39,1137,1159];

function drawAtlasSprite(ctx: CanvasRenderingContext2D,image:HTMLImageElement,cols:number,rows:number,col:number,row:number,bounds:Bounds,x:number,y:number,maxW:number,maxH:number) {
  const cellW=image.naturalWidth/cols,cellH=image.naturalHeight/rows;
  const [left,top,right,bottom]=bounds;
  const sourceW=right-left,sourceH=bottom-top;
  const scale=Math.min(maxW/sourceW,maxH/sourceH);
  const width=sourceW*scale,height=sourceH*scale;
  ctx.drawImage(image,col*cellW+left,row*cellH+top,sourceW,sourceH,x+(maxW-width)/2,y+maxH-height,width,height);
}
