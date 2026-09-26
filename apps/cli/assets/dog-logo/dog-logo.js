/**
 * StandardCode 小狗 Logo —— 可嵌入 Node CLI 的 CommonJS 实现。
 *
 * 网格：16 宽 x 18 高，每个格子在 SVG 里 = 1mm。
 * 图例：B=身体(棕黄) E=耳朵(深棕) W=白(嘴周) K=黑(眼/鼻) P=粉(舌) '.'=空
 */

const DOG_BITMAP = [
  "..EE........EE..", // 0
  ".EEEE......EEEE.", // 1
  ".EEEE.BBBB.EEEE.", // 2
  ".EEEBBBBBBBBEEE.", // 3
  ".EEBBBBBBBBBBEE.", // 4
  ".BBKKBBBBBBKKBB.", // 5
  ".BBKKBBBBBBKKBB.", // 6
  ".BBBBBBBBBBBBBB.", // 7
  ".BBBBWWWWWWBBBB.", // 8
  ".BBBBBWKKWBBBBB.", // 9
  ".BBBBWWPPWWBBBB.", // 10
  ".BBBBWWWWWWBBBB.", // 11
  ".BBBBBBBBBBBBBB.", // 12 下颌
  "....BBBBBBBB....", // 13 脖子
  "..BBBBBBBBBBBB..", // 14 胸/身体
  "..BBBBBBBBBBBB..", // 15 身体
  "...BB.BBBB.BB...", // 16 四条腿（中2前腿，外2后腿）
  "...BB.BBBB.BB...", // 17 爪子
];

const DOG_COLORS = {
  B: "#E8A86A", // 棕黄身体
  E: "#7A4B2B", // 深棕耳朵
  W: "#FFFFFF", // 白
  K: "#2B2B2B", // 近黑
  P: "#F4A6B6", // 粉舌
};

const W = 16;
const H = 18;

const TAIL_REST = new Set(["14,13", "15,10", "15,11", "15,12", "15,13"]);
const TAIL_WAG = new Set(["14,13", "15,11", "15,12", "15,13", "14,12"]);

function gridWithTail(tailSet) {
  const g = DOG_BITMAP.map((row) => row.split(""));
  for (const key of tailSet) {
    const [xs, ys] = key.split(",");
    const x = parseInt(xs, 10);
    const y = parseInt(ys, 10);
    if (y >= 0 && y < H && x >= 0 && x < W) {
      g[y][x] = "B";
    }
  }
  return g.map((row) => row.join(""));
}

function svgForDog(options) {
  options = options || {};
  const dw = options.displayWidth ?? 160;
  const dh = options.displayHeight ?? 180;
  const grid = gridWithTail(TAIL_REST);
  const rects = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ch = grid[y][x];
      if (ch === ".") continue;
      rects.push(`  <rect x="${x}" y="${y}" width="1" height="1" fill="${DOG_COLORS[ch]}"/>`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dw}" height="${dh}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">`,
    ...rects,
    "</svg>",
  ].join("\n");
}

function animatedSvgForDog(options) {
  options = options || {};
  const dw = options.displayWidth ?? 160;
  const dh = options.displayHeight ?? 180;
  const bodyRects = [];
  const noTailGrid = gridWithTail(new Set());
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ch = noTailGrid[y][x];
      if (ch === ".") continue;
      bodyRects.push(`  <rect x="${x}" y="${y}" width="1" height="1" fill="${DOG_COLORS[ch]}"/>`);
    }
  }
  const tailRects = [];
  for (const key of TAIL_REST) {
    const [xs, ys] = key.split(",");
    tailRects.push(`  <rect x="${xs}" y="${ys}" width="1" height="1" fill="${DOG_COLORS.B}"/>`);
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dw}" height="${dh}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">`,
    "  <g>",
    '    <animateTransform attributeName="transform" type="translate" values="0 0; 0 -0.5; 0 0" dur="2.6s" repeatCount="indefinite"/>',
    ...bodyRects,
    "    <g>",
    '      <animateTransform attributeName="transform" type="rotate" values="-14 14 13; 14 14 13; -14 14 13" dur="1.1s" repeatCount="indefinite"/>',
    ...tailRects,
    "    </g>",
    "  </g>",
    "</svg>",
  ].join("\n");
}

function asciiForGrid(grid, blink) {
  const rows = [];
  for (const r of grid) {
    let line = "";
    for (const c of r) {
      if (c === ".") {
        line += " ";
      } else if (c === "K" && !blink) {
        line += " ";
      } else {
        line += "█";
      }
    }
    rows.push(line);
  }
  return rows.join("\n");
}

function asciiFrame(tail, voffset, blink) {
  tail = tail || "rest";
  voffset = voffset || 0;
  blink = blink || false;
  const tailSet = tail === "rest" ? TAIL_REST : TAIL_WAG;
  let grid = gridWithTail(tailSet);
  if (voffset > 0) {
    grid = grid.slice(voffset).concat(Array(voffset).fill(" ".repeat(W)));
  } else if (voffset < 0) {
    grid = Array(-voffset).fill(" ".repeat(W)).concat(grid.slice(0, voffset));
  }
  return asciiForGrid(grid, blink);
}

const DOG_FRAMES = [
  asciiFrame("rest"),        // 0 idle
  asciiFrame("wag"),         // 1 wag
  asciiFrame("rest", 1),     // 2 up
  asciiFrame("rest", -1),    // 3 down
  asciiFrame("rest", 0, true), // 4 blink
];

const DOG_SEQUENCE = [0, 1, 0, 1, 2, 0, 3, 0, 4, 0];

function playDogAnimation(options) {
  options = options || {};
  const interval = options.intervalMs ?? 320;
  const seq = options.sequence ?? DOG_SEQUENCE;
  const frames = options.frames ?? DOG_FRAMES;

  const clear = () => {
    process.stdout.write(process.platform === "win32" ? "\x1Bc" : "\x1B[2J\x1B[H");
  };

  let i = 0;
  const timer = setInterval(() => {
    clear();
    process.stdout.write(frames[seq[i % seq.length]]);
    i++;
  }, interval);

  return function stop() {
    clearInterval(timer);
    clear();
    process.stdout.write(frames[0] + "\n🐶 bye\n");
  };
}

function startDogCli() {
  const stop = playDogAnimation();
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
}

module.exports = {
  DOG_BITMAP,
  DOG_COLORS,
  svgForDog,
  animatedSvgForDog,
  asciiForGrid,
  asciiFrame,
  DOG_FRAMES,
  DOG_SEQUENCE,
  playDogAnimation,
  startDogCli,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--play") || args.includes("-p")) {
    startDogCli();
  }
}
