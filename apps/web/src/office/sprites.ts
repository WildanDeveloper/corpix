import { Texture } from "pixi.js";

/** 12x16 pixel characters, drawn once and scaled with nearest-neighbour. */
export const SPRITE_W = 12;
export const SPRITE_H = 16;

export type Facing = "down" | "up" | "left" | "right";
export type Pose = "idle" | "walk" | "type" | "sit";

export interface Palette {
  skin: string;
  hair: string;
  shirt: string;
  shirtDark: string;
  trousers: string;
  shoes: string;
  accent: string;
}

export const ROLE_PALETTES: Record<string, Palette> = {
  boss: {
    skin: "#e8b48c",
    hair: "#2b2b33",
    shirt: "#c9a227",
    shirtDark: "#a8871d",
    trousers: "#2d2a3a",
    shoes: "#1a1a22",
    accent: "#ffd75e",
  },
  frontend: {
    skin: "#f0c19b",
    hair: "#5a3a24",
    shirt: "#3f7fd0",
    shirtDark: "#2f62a4",
    trousers: "#26303d",
    shoes: "#171b22",
    accent: "#7fb2ff",
  },
  backend: {
    skin: "#d9a074",
    hair: "#221a14",
    shirt: "#3f9e6b",
    shirtDark: "#2f7a52",
    trousers: "#232d33",
    shoes: "#141a1d",
    accent: "#6fd7a0",
  },
  devops: {
    skin: "#e6b58f",
    hair: "#3b2a1c",
    shirt: "#d07a3f",
    shirtDark: "#a85e2c",
    trousers: "#2b2622",
    shoes: "#1a1613",
    accent: "#ffab6b",
  },
  qa: {
    skin: "#f2c9a5",
    hair: "#4a2f4f",
    shirt: "#9b5fc0",
    shirtDark: "#7a4799",
    trousers: "#2a2433",
    shoes: "#191521",
    accent: "#c99bff",
  },
  docs: {
    skin: "#eec3a0",
    hair: "#2f4a4a",
    shirt: "#3fa8a8",
    shirtDark: "#2f8282",
    trousers: "#25313a",
    shoes: "#151d22",
    accent: "#7fdcdc",
  },
};

export const DEFAULT_PALETTE = ROLE_PALETTES.backend as Palette;

export function paletteFor(role: string): Palette {
  return ROLE_PALETTES[role] ?? DEFAULT_PALETTE;
}

/**
 * Draw one character frame into an RGBA buffer. Everything is rectangles on a
 * 12x16 grid, so it needs no art assets and stays crisp when scaled.
 */
export function drawFrame(
  palette: Palette,
  facing: Facing,
  pose: Pose,
  step: number,
): Uint8Array {
  const buffer = new Uint8Array(SPRITE_W * SPRITE_H * 4);
  const put = (x: number, y: number, color: string): void => {
    if (x < 0 || y < 0 || x >= SPRITE_W || y >= SPRITE_H) return;
    const [r, g, b] = hexToRgb(color);
    const offset = (y * SPRITE_W + x) * 4;
    buffer[offset] = r;
    buffer[offset + 1] = g;
    buffer[offset + 2] = b;
    buffer[offset + 3] = 255;
  };
  const rect = (x: number, y: number, w: number, h: number, color: string): void => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) put(x + dx, y + dy, color);
  };

  const seated = pose === "sit";
  const headY = seated ? 3 : 2;

  // Hair and head.
  rect(3, headY, 6, 5, palette.hair);
  rect(3, headY + 2, 6, 3, palette.skin);
  if (facing === "down" || facing === "left" || facing === "right") {
    const eyeY = headY + 3;
    if (facing === "down") {
      put(4, eyeY, "#1b1b22");
      put(7, eyeY, "#1b1b22");
    } else if (facing === "left") {
      put(4, eyeY, "#1b1b22");
    } else {
      put(7, eyeY, "#1b1b22");
    }
  }
  if (facing === "up") {
    rect(3, headY, 6, 5, palette.hair);
  }

  // Torso.
  const torsoY = headY + 5;
  rect(2, torsoY, 8, 5, palette.shirt);
  rect(2, torsoY, 8, 1, palette.accent);
  if (facing === "up") rect(4, torsoY + 1, 4, 4, palette.shirtDark);

  // Arms: typing raises the hands towards the desk.
  if (pose === "type") {
    rect(1, torsoY + 1, 1, 2, palette.shirtDark);
    rect(10, torsoY + 1, 1, 2, palette.shirtDark);
    rect(2, torsoY + 3, 2, 1, palette.skin);
    rect(8, torsoY + 3, 2, 1, palette.skin);
  } else if (pose === "walk" && step % 2 === 1) {
    rect(1, torsoY + 2, 1, 2, palette.shirtDark);
    rect(10, torsoY + 1, 1, 2, palette.shirtDark);
  } else {
    rect(1, torsoY + 1, 1, 3, palette.shirtDark);
    rect(10, torsoY + 1, 1, 3, palette.shirtDark);
  }

  // Legs: seated legs are shorter and forward.
  const legY = torsoY + 5;
  if (seated) {
    rect(3, legY, 2, 3, palette.trousers);
    rect(7, legY, 2, 3, palette.trousers);
    rect(3, legY + 3, 6, 1, palette.shoes);
  } else {
    const swing = pose === "walk" ? (step % 2 === 0 ? 0 : 1) : 0;
    rect(3, legY, 2, 4 - swing, palette.trousers);
    rect(7, legY, 2, 4 - swing, palette.trousers);
    rect(3, legY + 4 - swing, 2, 1, palette.shoes);
    rect(7, legY + 4 - swing, 2, 1, palette.shoes);
  }

  return buffer;
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

/**
 * Build (and cache) one texture per palette/facing/pose/frame combination. Pixi
 * needs a canvas or buffer source; a tiny offscreen canvas is the simplest.
 */
const cache = new Map<string, Texture>();

export function frameTexture(
  role: string,
  facing: Facing,
  pose: Pose,
  step: number,
): Texture {
  const key = `${role}|${facing}|${pose}|${step}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const buffer = drawFrame(paletteFor(role), facing, pose, step);
  const canvas = document.createElement("canvas");
  canvas.width = SPRITE_W;
  canvas.height = SPRITE_H;
  const context = canvas.getContext("2d");
  if (context) {
    const image = context.createImageData(SPRITE_W, SPRITE_H);
    image.data.set(buffer);
    context.putImageData(image, 0, 0);
  }
  const texture = Texture.from(canvas);
  texture.source.scaleMode = "nearest";
  cache.set(key, texture);
  return texture;
}

export function clearTextureCache(): void {
  for (const texture of cache.values()) texture.destroy(true);
  cache.clear();
}
