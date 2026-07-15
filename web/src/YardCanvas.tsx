import { useEffect, useRef, type MouseEvent } from "react";
import type { AgentState, RunSnapshot } from "./types";
import { childTrainTargetX, rootTrainTargetX } from "./yardMotion";

type Hit = { x: number; y: number; w: number; h: number; type: "dog" | "agent" | "tower"; id?: string };
type Light = "day" | "night";

const W = 1100;
const H = 680;

export function YardCanvas({ snapshot, selectedId, onSelect, light, petNonce, onPet }: {
  snapshot: RunSnapshot; selectedId?: string; onSelect: (id: string) => void; light: Light; petNonce: number; onPet: () => void;
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
    context.imageSmoothingEnabled = false;
    const dog = load("/assets/watchdog-sprites.png");
    const trains = load("/assets/train-sprites.png");
    const backdrop = load("/assets/yard-backdrop.png");
    const tower = load("/assets/signal-tower-v2.png");
    const tracks = load("/assets/track-atlas.png");
    const clouds = load("/assets/cloud-atlas.png");
    const smoke = load("/assets/smoke-sprites.png");
    let frame = 0;

    const render = (now: number) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
        canvas.width = Math.floor(rect.width * dpr); canvas.height = Math.floor(rect.height * dpr);
      }
      context.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
      const delta = Math.min(.08, Math.max(0, (now - frameAtRef.current) / 1000));
      frameAtRef.current = now;
      hitsRef.current = drawYard(context, snapshot, selectedId, light, (now - startRef.current) / 1000, petAtRef.current ? (now - petAtRef.current) / 1000 : 99, dog, trains, backdrop, tower, tracks, clouds, smoke, motionRef.current, delta);
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [snapshot, selectedId, light]);

  const locateHit = (event: MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) * W / rect.width;
    const y = (event.clientY - rect.top) * H / rect.height;
    return [...hitsRef.current].reverse().find((item) => x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h);
  };

  return <canvas ref={canvasRef} className="yard-canvas" aria-label="Interactive pixel-art rail yard" onMouseMove={(event) => {
    event.currentTarget.style.cursor = locateHit(event) ? "pointer" : "default";
  }} onMouseLeave={(event) => { event.currentTarget.style.cursor = "default"; }} onClick={(event) => {
    const hit = locateHit(event);
    if (hit?.type === "dog") onPet();
    else if (hit?.type === "tower") { const root = snapshot.agents.find((agent) => !agent.parentThreadId); if (root) onSelect(root.threadId); }
    else if (hit?.id) onSelect(hit.id);
  }} />;
}

function drawYard(ctx: CanvasRenderingContext2D, snapshot: RunSnapshot, selectedId: string | undefined, light: Light, t: number, petT: number, dog: HTMLImageElement, trains: HTMLImageElement, backdrop: HTMLImageElement, tower: HTMLImageElement, tracks: HTMLImageElement, clouds: HTMLImageElement, smoke: HTMLImageElement, motion: Map<string, { x: number; y: number }>, delta: number): Hit[] {
  const night = light === "night";
  ctx.fillStyle = night ? "#142b27" : "#547c48";
  ctx.fillRect(0, 0, W, H);
  if (backdrop.complete && backdrop.naturalWidth) { ctx.globalAlpha = night ? .26 : .38; ctx.drawImage(backdrop, 0, 0, W, H); ctx.globalAlpha = 1; }
  drawTerrain(ctx, night);
  drawClouds(ctx, clouds, night, t);
  if (night) { ctx.fillStyle="rgba(6,16,32,.28)"; ctx.fillRect(0,0,W,H); }
  const children = snapshot.agents.filter((agent) => agent.parentThreadId);
  const placements = layoutChildren(children);
  drawTracks(ctx, tracks, [...new Set(placements.map((placement) => placement.y))], night);
  drawStations(ctx, snapshot.loops[0]?.phase ?? "plan", night);

  const hits: Hit[] = [];
  drawTower(ctx, tower, night, selectedId === snapshot.agents.find((agent) => !agent.parentThreadId)?.threadId);
  const dogY = 137;
  drawDog(ctx, dog, 104, dogY, t, snapshot, petT);
  hits.push({ x: 18, y: 34, w: 280, h: 305, type: "tower" }, { x: 98, y: 128, w: 104, h: 108, type: "dog" });

  const roots = snapshot.agents.filter((agent) => !agent.parentThreadId);
  roots.forEach((agent, index) => {
    const loop = snapshot.loops.find((candidate) => candidate.threadId === agent.threadId);
    const targetX = rootTrainTargetX(loop, Boolean(agent.activeTurnId)) + index * 28;
    const { x, y } = easedPosition(motion, agent.threadId, targetX, MAIN_LINE_Y, delta);
    drawTrain(ctx, trains, smoke, agent, x, y, 0, selectedId === agent.threadId, t);
    hits.push({ x: x - 48, y: y - 44, w: 125, h: 84, type: "agent", id: agent.threadId });
  });

  placements.forEach(({ agent, x: baseX, y: baseY, variant }, index) => {
    const targetX = childTrainTargetX(baseX, Boolean(agent.activeTurnId), agent.latestActivity?.status);
    const position = easedPosition(motion, agent.threadId, targetX, baseY, delta);
    drawTrain(ctx, trains, smoke, agent, position.x, position.y, variant, selectedId === agent.threadId, t + index * .17);
    hits.push({ x: position.x - 48, y: position.y - 44, w: 125, h: 84, type: "agent", id: agent.threadId });
  });

  if (night) drawFireflies(ctx, t);
  return hits;
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
  if (children.length === 0) return [];
  const rowCount = Math.min(3, Math.max(1, Math.ceil(children.length / 5)));
  const ys = rowCount === 1 ? [272] : rowCount === 2 ? [272, 525] : [155, 282, 535];
  const perRow = Math.ceil(children.length / rowCount);
  return children.map((agent, index) => {
    const row = Math.floor(index / perRow);
    const rowStart = row * perRow;
    const count = Math.min(perRow, children.length - rowStart);
    const column = index - rowStart;
    const x = count === 1 ? 690 : 390 + column * (590 / (count - 1));
    return { agent, x, y: ys[row]!, variant: trainVariant(agent, index) };
  });
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

function drawTracks(ctx: CanvasRenderingContext2D, image: HTMLImageElement, branchYs: number[], night: boolean) {
  if (!image.complete || !image.naturalWidth) {
    ctx.fillStyle = night ? "#70756d" : "#776e5d";
    ctx.fillRect(260, MAIN_LINE_Y - 4, 765, 8);
    return;
  }
  ctx.save();
  ctx.globalAlpha = night ? .62 : .9;
  drawHorizontalRail(ctx, image, 255, 1035, MAIN_LINE_Y);
  branchYs.forEach((y, index) => {
    drawHorizontalRail(ctx, image, 320, 1035, y);
    const connectorX = index % 2 === 0 ? 990 : 350;
    drawVerticalRail(ctx, image, connectorX, Math.min(y, MAIN_LINE_Y), Math.max(y, MAIN_LINE_Y));
    drawTrackSprite(ctx, image, 2, 1, connectorX - 40, MAIN_LINE_Y - 39, 80, 80);
    drawTrackSprite(ctx, image, 3, 1, connectorX - 40, y - 39, 80, 80);
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

function drawStations(ctx: CanvasRenderingContext2D, phase: RunSnapshot["loops"][number]["phase"], night: boolean) {
  const stations = [{x:315,label:"PLAN"},{x:510,label:"EXECUTE"},{x:715,label:"VERIFY"},{x:915,label:"DONE"}];
  const activeIndex = phase === "plan" ? 0 : phase === "execute" ? 1 : phase === "done" ? 3 : 2;
  stations.forEach((station, i) => {
    const active = activeIndex === i;
    ctx.fillStyle = night ? "#17231f" : "#e4d9bd"; ctx.fillRect(station.x-38, 350, 76, 35);
    ctx.fillStyle = active ? "#f6c453" : (night ? "#8ea69b" : "#4d5b4a"); ctx.fillRect(station.x-32, 357, 64, 5);
    ctx.fillStyle = night ? "#d9e5dc" : "#273229"; ctx.font = "700 11px ui-monospace"; ctx.textAlign="center"; ctx.fillText(station.label, station.x, 378);
    ctx.fillStyle = active ? "#ffcc55" : "#294238"; ctx.fillRect(station.x-4, 329, 8, 16);
  });
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
  const severe = snapshot.loops.some((loop) => loop.warnings.some((warning) => /runaway|stalled|failed|budget|blocked/i.test(warning)));
  const petting = petT < .9;
  const row = petting ? 2 : severe ? 3 : snapshot.agents.some((agent) => agent.activeTurnId) ? 1 : 0;
  if (image.complete && image.naturalWidth) {
    const cols=4, rows=4;
    const col=petting ? Math.min(3,Math.floor(petT/.9*4)) : Math.floor(t*1.5)%4;
    const bounds = DOG_BOUNDS[row]![col]!;
    drawDogSprite(ctx,image,cols,rows,col,row,bounds,x+46,y+92,.36);
  } else {
    ctx.font="64px serif"; ctx.textAlign="left"; ctx.fillText("🐕",x+8,y+68);
  }
  if (petT < .9) {
    for (let i=0;i<3;i++) { const p=Math.max(0,petT-i*.12); ctx.fillStyle=i===1?"#f4eee0":"#ffffff"; pixelHeart(ctx,x+23+i*22,y+13-i*3-p*62,.68-p*.08); }
  }
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

function drawTrain(ctx: CanvasRenderingContext2D, image: HTMLImageElement, smoke: HTMLImageElement, agent: AgentState, x: number, y: number, variant: number, selected: boolean, t: number) {
  if (selected) { ctx.fillStyle="#f3c64f"; ctx.fillRect(x-52,y-49,126,4); ctx.fillRect(x-56,y-45,4,78); ctx.fillRect(x+74,y-45,4,78); }
  if (agent.activeTurnId) drawSmoke(ctx, smoke, x + [-14,-20,-3,7][variant%4]!, y - 35, t, agent.threadId);
  if (image.complete && image.naturalWidth) {
    const cols=4,rows=2,row=1,col=variant%4;
    drawAtlasSprite(ctx,image,cols,rows,col,row,TRAIN_BOUNDS[row]![col]!,x-48,y-46,120,90);
  } else {
    ctx.fillStyle=variant===0?"#d95b43":["#5f9ec5","#d3a34a","#7d6eb2"][variant-1]??"#5f9ec5"; ctx.fillRect(x-27,y-22,62,30); ctx.fillRect(x-15,y-38,28,18); ctx.fillStyle="#1f2925"; ctx.fillRect(x-20,y+8,14,14);ctx.fillRect(x+22,y+8,14,14);
  }
  ctx.fillStyle="#111915"; ctx.fillRect(x-48,y+38,120,25); ctx.fillStyle="#f3eedf"; ctx.font="700 12px ui-monospace"; ctx.textAlign="center"; ctx.fillText(agent.nickname??(agent.parentThreadId?agent.threadId.slice(0,8):"ROOT"),x+12,y+55);
}

function drawSmoke(ctx: CanvasRenderingContext2D, image: HTMLImageElement, anchorX: number, anchorY: number, t: number, id: string) {
  if (!image.complete || !image.naturalWidth) return;
  const offset = stableHash(id) % 19 / 7;
  const cycle = (t + offset) % 4.8;
  if (cycle >= 3.6) return;
  const frame = Math.min(3, Math.floor(cycle / .9));
  drawAtlasSprite(ctx, image, 4, 1, frame, 0, SMOKE_BOUNDS[0]![frame]!, anchorX - 24, anchorY - 64, 48, 64);
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
  [[29,175,314,510],[0,219,313,509],[0,226,305,510],[15,226,284,510]],
  [[29,99,314,327],[0,118,313,326],[0,126,305,327],[15,122,284,327]],
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
