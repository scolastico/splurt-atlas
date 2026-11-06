// Station imagery is drawn with WebGL: every tile strip becomes a texture and
// each visible tile is one textured quad, with deck shading applied in the
// fragment shader. Canvas 2D stays for annotations only. Shading a deck per
// draw is exactly equivalent to shading its composite: mixing toward one
// constant color is linear in the premultiplied pixel.
const VERTEX = `attribute vec2 a_pos;uniform vec4 u_rect;uniform vec4 u_uv;varying vec2 v_uv;
void main(){gl_Position=vec4(u_rect.xy+a_pos*u_rect.zw,0.0,1.0);v_uv=u_uv.xy+a_pos*u_uv.zw;}`;
const FRAGMENT = `precision mediump float;uniform sampler2D u_tex;uniform vec4 u_shade;varying vec2 v_uv;
void main(){vec4 c=texture2D(u_tex,v_uv);gl_FragColor=vec4(mix(c.rgb,u_shade.rgb*c.a,u_shade.a),c.a);}`;

export function createGlRenderer(canvas) {
  const options = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' };
  let gl = null;
  try { gl = canvas.getContext('webgl2', options) || canvas.getContext('webgl', options); } catch { gl = null; }
  if (!gl) return null;
  const compile = (type, source) => { const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)); return shader; };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX)); gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT)); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'a_pos'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniforms = { rect: gl.getUniformLocation(program, 'u_rect'), uv: gl.getUniformLocation(program, 'u_uv'), shade: gl.getUniformLocation(program, 'u_shade'), tex: gl.getUniformLocation(program, 'u_tex') };
  gl.uniform1i(uniforms.tex, 0);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  let width = canvas.width, height = canvas.height, shade = [0, 0, 0, 0], bound = null;
  const upload = source => {
    const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); bound = texture;
    return texture;
  };
  return {
    kind: 'webgl',
    resize(nextWidth, nextHeight) { width = nextWidth; height = nextHeight; gl.viewport(0, 0, width, height); },
    begin() { gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); },
    // A strip becomes one texture with per-slot UV ranges, or one texture per
    // slot when the strip is taller than the device allows.
    async prepare(bitmap, slots) {
      const slotHeight = bitmap.height / slots, handle = { slots: [], bytes: bitmap.width * bitmap.height * 4, width: bitmap.width, slotHeight, textures: [] };
      if (bitmap.height <= maxTexture) {
        const texture = upload(bitmap); handle.textures.push(texture);
        for (let slot = 0; slot < slots; slot++) handle.slots.push({ texture, v0: slot / slots, vScale: 1 / slots });
      } else {
        for (let slot = 0; slot < slots; slot++) {
          const part = await createImageBitmap(bitmap, 0, slot * slotHeight, bitmap.width, slotHeight);
          const texture = upload(part); part.close?.(); handle.textures.push(texture); handle.slots.push({ texture, v0: 0, vScale: 1 });
        }
      }
      bitmap.close?.();
      return handle;
    },
    release(handle) { for (const texture of handle.textures) gl.deleteTexture(texture); if (handle.textures.includes(bound)) bound = null; },
    beginDeck(depthShade) { shade = [5 / 255, 12 / 255, 22 / 255, depthShade]; gl.uniform4fv(uniforms.shade, shade); },
    endDeck() {},
    // Source rectangle in slot pixels, destination in device pixels.
    draw(handle, slot, sx, sy, sw, sh, dx, dy, dw, dh) {
      const entry = handle.slots[slot]; if (!entry) return;
      if (bound !== entry.texture) { gl.bindTexture(gl.TEXTURE_2D, entry.texture); bound = entry.texture; }
      gl.uniform4f(uniforms.rect, dx / width * 2 - 1, 1 - dy / height * 2, dw / width * 2, -dh / height * 2);
      gl.uniform4f(uniforms.uv, sx / handle.width, entry.v0 + sy / handle.slotHeight * entry.vScale, sw / handle.width, sh / handle.slotHeight * entry.vScale);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    end() { gl.flush(); }
  };
}

// Canvas 2D fallback for browsers without WebGL: deeper decks are shaded
// through one intermediate canvas per deck as before.
export function create2dRenderer(canvas) {
  const context = canvas.getContext('2d'), layer = document.createElement('canvas'), lc = layer.getContext('2d');
  let target = context, shade = 0;
  return {
    kind: 'canvas',
    resize(width, height) { layer.width = width; layer.height = height; },
    begin() { context.setTransform(1, 0, 0, 1, 0, 0); context.globalCompositeOperation = 'source-over'; context.clearRect(0, 0, canvas.width, canvas.height); },
    async prepare(bitmap, slots) { return { bitmap, slots, bytes: bitmap.width * bitmap.height * 4, slotHeight: bitmap.height / slots }; },
    release(handle) { handle.bitmap.close?.(); },
    beginDeck(depthShade) { shade = depthShade; target = depthShade ? lc : context; if (depthShade) { lc.setTransform(1, 0, 0, 1, 0, 0); lc.clearRect(0, 0, layer.width, layer.height); } target.setTransform(1, 0, 0, 1, 0, 0); target.imageSmoothingEnabled = false; },
    endDeck() {
      if (!shade) return;
      lc.setTransform(1, 0, 0, 1, 0, 0); lc.globalCompositeOperation = 'source-atop'; lc.fillStyle = `rgba(5,12,22,${shade})`; lc.fillRect(0, 0, layer.width, layer.height); lc.globalCompositeOperation = 'source-over';
      context.setTransform(1, 0, 0, 1, 0, 0); context.drawImage(layer, 0, 0);
    },
    draw(handle, slot, sx, sy, sw, sh, dx, dy, dw, dh) { target.drawImage(handle.bitmap, sx, sy + slot * handle.slotHeight, sw, sh, dx, dy, dw, dh); },
    end() {}
  };
}
