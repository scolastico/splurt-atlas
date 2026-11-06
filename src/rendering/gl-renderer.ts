// Station imagery is drawn with WebGL: every tile strip becomes a texture and
// each visible tile is one textured quad, with deck shading applied in the
// fragment shader. Canvas 2D stays for annotations only. Shading a deck per
// draw is exactly equivalent to shading its composite: mixing toward one
// constant color is linear in the premultiplied pixel.

/** A decoded strip ready to draw; `slots` are the vertically stacked channels. */
export interface TextureHandle {
  bytes: number;
}

export interface Renderer {
  kind: 'webgl' | 'canvas';
  resize(width: number, height: number): void;
  /** Clears the canvas before a frame. */
  begin(): void;
  /** Uploads a decoded strip with `slots` stacked channels. The bitmap is consumed. */
  prepare(bitmap: ImageBitmap, slots: number): Promise<TextureHandle>;
  release(handle: TextureHandle): void;
  /** Starts a deck; `depthShade` is 0 for the viewed deck and grows for deeper decks. */
  beginDeck(depthShade: number): void;
  endDeck(): void;
  /** Source rectangle in slot pixels, destination in device pixels. */
  draw(
    handle: TextureHandle,
    slot: number,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  end(): void;
}

const VERTEX_SHADER = `attribute vec2 a_pos;uniform vec4 u_rect;uniform vec4 u_uv;varying vec2 v_uv;
void main(){gl_Position=vec4(u_rect.xy+a_pos*u_rect.zw,0.0,1.0);v_uv=u_uv.xy+a_pos*u_uv.zw;}`;
const FRAGMENT_SHADER = `precision mediump float;uniform sampler2D u_tex;uniform vec4 u_shade;varying vec2 v_uv;
void main(){vec4 c=texture2D(u_tex,v_uv);gl_FragColor=vec4(mix(c.rgb,u_shade.rgb*c.a,u_shade.a),c.a);}`;

/** The shade color deeper decks mix toward (a dark blue), as GL components. */
const SHADE_RGB = [5 / 255, 12 / 255, 22 / 255] as const;

interface GlSlot {
  texture: WebGLTexture;
  /** Vertical start and extent of the slot within its texture, in texture coordinates. */
  v0: number;
  vScale: number;
}

interface GlHandle extends TextureHandle {
  slots: GlSlot[];
  width: number;
  slotHeight: number;
  textures: WebGLTexture[];
}

export function createGlRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const options: WebGLContextAttributes = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  };
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2', options) || canvas.getContext('webgl', options);
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const context = gl;

  const compile = (type: number, source: string): WebGLShader => {
    const shader = context.createShader(type);
    if (!shader) throw new Error('Could not create a shader');
    context.shaderSource(shader, source);
    context.compileShader(shader);
    if (!context.getShaderParameter(shader, context.COMPILE_STATUS))
      throw new Error(context.getShaderInfoLog(shader) || 'Shader compilation failed');
    return shader;
  };
  const program = context.createProgram();
  if (!program) throw new Error('Could not create a shader program');
  context.attachShader(program, compile(context.VERTEX_SHADER, VERTEX_SHADER));
  context.attachShader(program, compile(context.FRAGMENT_SHADER, FRAGMENT_SHADER));
  context.linkProgram(program);
  if (!context.getProgramParameter(program, context.LINK_STATUS))
    throw new Error(context.getProgramInfoLog(program) || 'Shader linking failed');
  context.useProgram(program);

  // One unit quad; every draw positions it through the rect and uv uniforms.
  const buffer = context.createBuffer();
  context.bindBuffer(context.ARRAY_BUFFER, buffer);
  context.bufferData(context.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), context.STATIC_DRAW);
  const position = context.getAttribLocation(program, 'a_pos');
  context.enableVertexAttribArray(position);
  context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);
  const uniforms = {
    rect: context.getUniformLocation(program, 'u_rect'),
    uv: context.getUniformLocation(program, 'u_uv'),
    shade: context.getUniformLocation(program, 'u_shade'),
    tex: context.getUniformLocation(program, 'u_tex'),
  };
  context.uniform1i(uniforms.tex, 0);
  context.enable(context.BLEND);
  context.blendFunc(context.ONE, context.ONE_MINUS_SRC_ALPHA);
  context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
  const maxTextureSize = context.getParameter(context.MAX_TEXTURE_SIZE) as number;

  let width = canvas.width;
  let height = canvas.height;
  let boundTexture: WebGLTexture | null = null;

  const upload = (source: ImageBitmap): WebGLTexture => {
    const texture = context.createTexture();
    if (!texture) throw new Error('Could not create a texture');
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, context.RGBA, context.UNSIGNED_BYTE, source);
    boundTexture = texture;
    return texture;
  };

  return {
    kind: 'webgl',
    resize(nextWidth, nextHeight) {
      width = nextWidth;
      height = nextHeight;
      context.viewport(0, 0, width, height);
    },
    begin() {
      context.viewport(0, 0, width, height);
      context.clearColor(0, 0, 0, 0);
      context.clear(context.COLOR_BUFFER_BIT);
    },
    // A strip becomes one texture with per-slot UV ranges, or one texture per
    // slot when the strip is taller than the device allows.
    async prepare(bitmap, slots) {
      const slotHeight = bitmap.height / slots;
      const handle: GlHandle = {
        slots: [],
        bytes: bitmap.width * bitmap.height * 4,
        width: bitmap.width,
        slotHeight,
        textures: [],
      };
      if (bitmap.height <= maxTextureSize) {
        const texture = upload(bitmap);
        handle.textures.push(texture);
        for (let slot = 0; slot < slots; slot++)
          handle.slots.push({ texture, v0: slot / slots, vScale: 1 / slots });
      } else {
        for (let slot = 0; slot < slots; slot++) {
          const part = await createImageBitmap(bitmap, 0, slot * slotHeight, bitmap.width, slotHeight);
          const texture = upload(part);
          part.close?.();
          handle.textures.push(texture);
          handle.slots.push({ texture, v0: 0, vScale: 1 });
        }
      }
      bitmap.close?.();
      return handle;
    },
    release(handle) {
      const { textures } = handle as GlHandle;
      for (const texture of textures) context.deleteTexture(texture);
      if (boundTexture && textures.includes(boundTexture)) boundTexture = null;
    },
    beginDeck(depthShade) {
      context.uniform4fv(uniforms.shade, [...SHADE_RGB, depthShade]);
    },
    endDeck() {},
    draw(handle, slot, sx, sy, sw, sh, dx, dy, dw, dh) {
      const { slots, width: stripWidth, slotHeight } = handle as GlHandle;
      const entry = slots[slot];
      if (!entry) return;
      if (boundTexture !== entry.texture) {
        context.bindTexture(context.TEXTURE_2D, entry.texture);
        boundTexture = entry.texture;
      }
      // Device pixels map to clip space with y pointing up.
      context.uniform4f(
        uniforms.rect,
        (dx / width) * 2 - 1,
        1 - (dy / height) * 2,
        (dw / width) * 2,
        (-dh / height) * 2,
      );
      context.uniform4f(
        uniforms.uv,
        sx / stripWidth,
        entry.v0 + (sy / slotHeight) * entry.vScale,
        sw / stripWidth,
        (sh / slotHeight) * entry.vScale,
      );
      context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
    },
    end() {
      context.flush();
    },
  };
}

interface CanvasHandle extends TextureHandle {
  bitmap: ImageBitmap;
  slots: number;
  slotHeight: number;
}

/** Canvas 2D fallback for browsers without WebGL: deeper decks are shaded through one intermediate canvas. */
export function create2dRenderer(canvas: HTMLCanvasElement): Renderer {
  const context = canvas.getContext('2d')!;
  const layer = document.createElement('canvas');
  const layerContext = layer.getContext('2d')!;
  let target = context;
  let shade = 0;
  return {
    kind: 'canvas',
    resize(width, height) {
      layer.width = width;
      layer.height = height;
    },
    begin() {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = 'source-over';
      context.clearRect(0, 0, canvas.width, canvas.height);
    },
    async prepare(bitmap, slots) {
      const handle: CanvasHandle = {
        bitmap,
        slots,
        bytes: bitmap.width * bitmap.height * 4,
        slotHeight: bitmap.height / slots,
      };
      return handle;
    },
    release(handle) {
      (handle as CanvasHandle).bitmap.close?.();
    },
    beginDeck(depthShade) {
      shade = depthShade;
      target = depthShade ? layerContext : context;
      if (depthShade) {
        layerContext.setTransform(1, 0, 0, 1, 0, 0);
        layerContext.clearRect(0, 0, layer.width, layer.height);
      }
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.imageSmoothingEnabled = false;
    },
    endDeck() {
      if (!shade) return;
      layerContext.setTransform(1, 0, 0, 1, 0, 0);
      layerContext.globalCompositeOperation = 'source-atop';
      layerContext.fillStyle = `rgba(5,12,22,${shade})`;
      layerContext.fillRect(0, 0, layer.width, layer.height);
      layerContext.globalCompositeOperation = 'source-over';
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(layer, 0, 0);
    },
    draw(handle, slot, sx, sy, sw, sh, dx, dy, dw, dh) {
      const { bitmap, slotHeight } = handle as CanvasHandle;
      target.drawImage(bitmap, sx, sy + slot * slotHeight, sw, sh, dx, dy, dw, dh);
    },
    end() {},
  };
}
