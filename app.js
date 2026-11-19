"use strict";

const id = (name) => document.getElementById(name);
const fileInput = id("file");
const stage = id("stage");
const comparison = id("comparison");
const imageStack = id("image-stack");
const original = id("original");
const result = id("result");
const widthInput = id("width");
const heightInput = id("height");
const lock = id("lock");
const colors = id("colors");
const colorPresets = id("color-presets");
const dither = id("dither");
const longEdge = id("long-edge");
const scaleInput = id("scale");
const resizeMethod = id("resize-method");
const colorInputs = [...document.querySelectorAll(".color-controls input")];
const split = id("split");
const download = id("download");
const maxSide = Number(widthInput.max);
const maxExportSide = 8192;
const maxExportPixels = 16_777_216;
const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

let source;
let filename;
let loadVersion = 0;
let scalePercent = 100;
let colorLimit = colors.valueAsNumber;
let width = 0;
let height = 0;
let renderFrame = 0;
let converted = false;
let saving = false;
let dragDepth = 0;

function showMessage(name, message = "") {
  const element = id(name);
  element.textContent = message;
  element.hidden = !message;
}

function selectButton(group, key, value) {
  for (const button of group.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", Number(button.dataset[key]) === value);
  }
}

function setLongEdge(value) {
  longEdge.value = value;
  id("long-edge-value").value = `${value} px`;
  selectButton(id("presets"), "size", value);
  if (!source) return;
  const factor = value / Math.max(source.naturalWidth, source.naturalHeight);
  setDimensions(source.naturalWidth * factor, source.naturalHeight * factor);
}

function setDimensions(nextWidth, nextHeight) {
  width = Math.max(1, Math.min(maxSide, Math.round(nextWidth)));
  height = Math.max(1, Math.min(maxSide, Math.round(nextHeight)));
  widthInput.value = width;
  heightInput.value = height;
  scheduleRender();
}

function editDimensions(event) {
  const input = event.target;
  const value = input.valueAsNumber;
  if (!Number.isInteger(value) || value < 1 || value > maxSide) {
    if (event.type === "change") input.value = input === widthInput ? width : height;
    return;
  }
  selectButton(id("presets"), "size", null);
  let nextWidth = input === widthInput ? value : width;
  let nextHeight = input === heightInput ? value : height;
  if (lock.checked) {
    const aspect = source.naturalWidth / source.naturalHeight;
    if (input === widthInput) nextHeight = nextWidth / aspect;
    else nextWidth = nextHeight * aspect;
    const fit = Math.min(1, maxSide / Math.max(nextWidth, nextHeight));
    nextWidth *= fit;
    nextHeight *= fit;
  }
  setDimensions(nextWidth, nextHeight);
}

async function loadImage(file) {
  if (!file) return;
  const version = ++loadVersion;
  showMessage("load-error");
  const url = URL.createObjectURL(file);
  try {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const four = (offset) => String.fromCharCode(...bytes.slice(offset, offset + 4));
    const valid = (bytes[0] === 137 && four(1) === "PNG\r") ||
      (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
      (four(0) === "RIFF" && four(8) === "WEBP");
    if (!valid) throw new Error("PNG・JPEG・WebPの画像を選んでください。");
    const image = new Image();
    image.src = url;
    await image.decode();
    if (version !== loadVersion) return;

    const oldSource = source;
    source = image;
    original.src = url;
    if (oldSource) URL.revokeObjectURL(oldSource.src);
    filename = file.name;
    id("filename").textContent = filename;
    id("source-size").textContent = `${image.naturalWidth} × ${image.naturalHeight} px`;
    widthInput.disabled = false;
    heightInput.disabled = false;
    id("placeholder").hidden = true;
    comparison.hidden = false;
    setLongEdge(longEdge.valueAsNumber);
  } catch (error) {
    if (version === loadVersion) {
      const unsupported = error.message === "PNG・JPEG・WebPの画像を選んでください。";
      showMessage("load-error", unsupported ? error.message : "画像を読み込めませんでした。ファイルを確認してください。");
    }
  } finally {
    if (source?.src !== url) URL.revokeObjectURL(url);
  }
}

// For reduction, use the fraction of each source pixel covered by the output.
// If one axis is enlarged, keep nearest sampling on that axis.
function samplingSpans(sourceSize, targetSize) {
  const factor = sourceSize / targetSize;
  return Array.from({ length: targetSize }, (_, index) => {
    if (factor <= 1) return { start: Math.floor((index + 0.5) * factor), weights: [1] };
    const left = index * factor;
    const right = index === targetSize - 1 ? sourceSize : (index + 1) * factor;
    const start = Math.floor(left);
    const weights = Array.from({ length: Math.ceil(right) - start }, (_, offset) => {
      const pixel = start + offset;
      return (Math.min(right, pixel + 1) - Math.max(left, pixel)) / (right - left);
    });
    return { start, weights };
  });
}

function averageResize(image, targetWidth, targetHeight) {
  const canvas = document.createElement("canvas");
  const sourceWidth = canvas.width = image.naturalWidth;
  const sourceHeight = canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);

  const columns = samplingSpans(sourceWidth, targetWidth);
  const rows = samplingSpans(sourceHeight, targetHeight);
  const output = new ImageData(targetWidth, targetHeight);
  const horizontal = new Float64Array(targetWidth * 4);
  const accumulated = new Float64Array(horizontal.length);
  const batchHeight = 32;
  let batchStart = -batchHeight;
  let batch;
  let cachedY = -1;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    accumulated.fill(0);
    for (let dy = 0; dy < row.weights.length; dy++) {
      const sourceY = row.start + dy;
      if (sourceY !== cachedY) {
        if (sourceY >= batchStart + batchHeight) {
          batchStart = sourceY;
          batch = context.getImageData(0, sourceY, sourceWidth, Math.min(batchHeight, sourceHeight - sourceY)).data;
        }
        const rowOffset = (sourceY - batchStart) * sourceWidth * 4;
        horizontal.fill(0);
        for (let x = 0; x < columns.length; x++) {
          const column = columns[x];
          const target = x * 4;
          for (let dx = 0; dx < column.weights.length; dx++) {
            const pixel = rowOffset + (column.start + dx) * 4;
            const alpha = batch[pixel + 3] * column.weights[dx];
            // Premultiply so transparent neighbors add no tint.
            horizontal[target] += batch[pixel] * alpha;
            horizontal[target + 1] += batch[pixel + 1] * alpha;
            horizontal[target + 2] += batch[pixel + 2] * alpha;
            horizontal[target + 3] += alpha;
          }
        }
        cachedY = sourceY;
      }
      for (let i = 0; i < horizontal.length; i++) accumulated[i] += horizontal[i] * row.weights[dy];
    }
    for (let i = 0; i < accumulated.length; i += 4) {
      const alpha = accumulated[i + 3];
      if (alpha <= 0) continue;
      const offset = y * horizontal.length + i;
      output.data[offset] = accumulated[i] / alpha;
      output.data[offset + 1] = accumulated[i + 1] / alpha;
      output.data[offset + 2] = accumulated[i + 2] / alpha;
      output.data[offset + 3] = Math.round(alpha);
    }
  }
  return output;
}

function rotateHue(r, g, b, rotation) {
  const high = Math.max(r, g, b);
  const chroma = high - Math.min(r, g, b);
  if (!chroma) return [r, g, b];
  let sector;
  if (high === r) sector = (g - b) / chroma;
  else if (high === g) sector = 2 + (b - r) / chroma;
  else sector = 4 + (r - g) / chroma;
  sector = (sector + rotation + 12) % 6;
  const channel = (phase) => {
    const position = (phase + sector) % 6;
    return high - chroma * Math.max(0, Math.min(position, 4 - position, 1));
  };
  return [channel(5), channel(3), channel(1)];
}

function adjustColors(pixels, [saturation, contrast, brightness, temperature, hue, gamma, red, green, blue]) {
  const saturationFactor = 1 + saturation / 100;
  const contrastFactor = 2 ** (2 * contrast / 100);
  const exposure = brightness * 1.275;
  const warmth = temperature * 0.64;
  const gains = [red, green, blue].map((tint) => 1 + tint / 100);
  const gammaExponent = 1 / gamma;
  const tune = (color, gain, tint) => {
    const level = (color - 127.5) * contrastFactor + 127.5 + exposure + tint;
    const normalized = Math.max(0, Math.min(255, level * gain)) / 255;
    return 255 * normalized ** gammaExponent;
  };
  const { data } = pixels;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    let r = data[i], g = data[i + 1], b = data[i + 2];
    if (hue) [r, g, b] = rotateHue(r, g, b, hue / 60);
    if (saturation) {
      const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
      r = luminance + (r - luminance) * saturationFactor;
      g = luminance + (g - luminance) * saturationFactor;
      b = luminance + (b - luminance) * saturationFactor;
    }
    data[i] = tune(r, gains[0], warmth);
    data[i + 1] = tune(g, gains[1], 0);
    data[i + 2] = tune(b, gains[2], -warmth);
  }
}

function colorBox(samples) {
  const low = [255, 255, 255];
  const high = [0, 0, 0];
  let count = 0;
  for (const sample of samples) {
    count += sample[3];
    for (let c = 0; c < 3; c++) {
      low[c] = Math.min(low[c], sample[c]);
      high[c] = Math.max(high[c], sample[c]);
    }
  }
  const ranges = high.map((value, index) => value - low[index]);
  const range = Math.max(...ranges);
  return { samples, count, axis: ranges.indexOf(range), score: samples.length > 1 ? range * count : 0 };
}

function makePalette(data, limit) {
  const exact = new Set();
  // Accumulate actual RGB values in 5-bit buckets for weighted median cuts.
  const bins = new Uint32Array(32768 * 4);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (exact.size <= limit) exact.add((r << 16) | (g << 8) | b);
    const bin = (((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)) * 4;
    bins[bin] += r;
    bins[bin + 1] += g;
    bins[bin + 2] += b;
    bins[bin + 3]++;
  }
  if (exact.size <= limit) return [];

  const samples = [];
  for (let i = 0; i < bins.length; i += 4) {
    const count = bins[i + 3];
    if (count) samples.push([bins[i] / count, bins[i + 1] / count, bins[i + 2] / count, count]);
  }
  const boxes = [colorBox(samples)];
  while (boxes.length < limit) {
    let index = 0;
    for (let i = 1; i < boxes.length; i++) {
      if (boxes[i].score > boxes[index].score) index = i;
    }
    const { samples, count, axis, score } = boxes[index];
    if (!score) break;
    samples.sort((a, b) => a[axis] - b[axis]);
    let total = samples[0][3];
    let middle = 1;
    while (total < count / 2 && middle < samples.length - 1) {
      total += samples[middle][3];
      middle++;
    }
    boxes.splice(index, 1, colorBox(samples.slice(0, middle)), colorBox(samples.slice(middle)));
  }
  return boxes.map(({ samples, count }) => {
    const sums = [0, 0, 0];
    for (const sample of samples) {
      for (let c = 0; c < 3; c++) sums[c] += sample[c] * sample[3];
    }
    return sums.map((value) => Math.round(value / count));
  });
}

function reduceColors(pixels, limit, ditherStrength) {
  const { data, width } = pixels;
  const palette = makePalette(data, limit);
  if (!palette.length) return;

  const cache = new Map();
  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel++) {
    if (data[i + 3] === 0) continue;
    const phase = ditherStrength ? bayer[((Math.floor(pixel / width) & 3) * 4) + (pixel % width & 3)] : 0;
    const offset = ditherStrength ? (phase - 7.5) * 2 * ditherStrength / 100 : 0;
    const r = Math.min(255, Math.max(0, data[i] + offset));
    const g = Math.min(255, Math.max(0, data[i + 1] + offset));
    const b = Math.min(255, Math.max(0, data[i + 2] + offset));
    const key = (phase << 24) | (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let nearest = cache.get(key);
    if (!nearest) {
      let distance = Infinity;
      for (const color of palette) {
        const next = (r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2;
        if (next < distance) {
          nearest = color;
          distance = next;
        }
      }
      if (cache.size < 65536) cache.set(key, nearest);
    }
    data[i] = nearest[0];
    data[i + 1] = nearest[1];
    data[i + 2] = nearest[2];
  }
}

function updateSplit() {
  const percent = Number(split.value) / 100;
  comparison.style.setProperty("--split", `${split.value}%`);
  const imageWidth = imageStack.offsetWidth;
  const stageWidth = comparison.clientWidth;
  const imagePercent = imageWidth
    ? (stageWidth * percent - (stageWidth - imageWidth) / 2) / imageWidth : percent;
  imageStack.style.setProperty("--image-split", `${Math.max(0, Math.min(1, imagePercent)) * 100}%`);
}

function fitPreview() {
  if (!source) return;
  const factor = Math.min(
    Math.max(1, comparison.clientWidth - 28) / width,
    Math.max(1, comparison.clientHeight - 28) / height,
  );
  imageStack.style.width = `${width * factor}px`;
  imageStack.style.height = `${height * factor}px`;
  updateSplit();
}

function exportSize() {
  const scaled = (size) => Math.max(1, Math.round(size * scalePercent / 100));
  return [scaled(width), scaled(height)];
}

function inputScalePercent() {
  const percent = Math.round(scaleInput.valueAsNumber * 100);
  return scaleInput.validity.valid && Number.isSafeInteger(percent) ? percent : null;
}

function updateExport() {
  const [exportWidth, exportHeight] = exportSize();
  const validScale = inputScalePercent() !== null;
  id("output-size").value = source && validScale ? `${exportWidth} × ${exportHeight} px` : "—";
  const tooLarge = exportWidth > maxExportSide || exportHeight > maxExportSide || exportWidth * exportHeight > maxExportPixels;
  download.disabled = !converted || saving || tooLarge || !validScale;
  const error = !validScale ? "倍率は0.01以上で小数第2位まで入力してください。"
    : tooLarge ? "保存できるのは各辺8192 px以下、合計16,777,216画素以下です。解像度か倍率を下げてください。" : "";
  showMessage("save-error", error);
}

function render() {
  renderFrame = 0;
  try {
    result.width = width;
    result.height = height;
    const context = result.getContext("2d", { willReadFrequently: true });
    const adjustmentValues = colorInputs.map((input) => input.valueAsNumber);
    const hasAdjustments = colorInputs.some((input) => Number(input.defaultValue) !== input.valueAsNumber);
    let pixels;
    if (resizeMethod.value === "average" && (width < source.naturalWidth || height < source.naturalHeight)) {
      pixels = averageResize(source, width, height);
    } else {
      context.imageSmoothingEnabled = false;
      context.drawImage(source, 0, 0, width, height);
    }
    if (pixels || hasAdjustments || colorLimit) {
      pixels ??= context.getImageData(0, 0, width, height);
      if (hasAdjustments) adjustColors(pixels, adjustmentValues);
      if (colorLimit) reduceColors(pixels, colorLimit, dither.valueAsNumber);
      context.putImageData(pixels, 0, 0);
    }
    fitPreview();
    converted = true;
    showMessage("convert-error");
  } catch {
    showMessage("convert-error", "画像を変換できませんでした。解像度を下げてお試しください。");
  }
  updateExport();
}

function scheduleRender() {
  dither.disabled = colorLimit === 0;
  if (!source) return;
  converted = false;
  updateExport();
  if (!renderFrame) renderFrame = requestAnimationFrame(render);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value;
});

function pngChunk(type, data) {
  const prefix = new Uint8Array(8);
  new DataView(prefix.buffer).setUint32(0, data.length);
  prefix.set(new TextEncoder().encode(type), 4);
  let crc = 0xffffffff;
  for (let i = 4; i < prefix.length; i++) crc = crcTable[(crc ^ prefix[i]) & 255] ^ (crc >>> 8);
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const suffix = new Uint8Array(4);
  new DataView(suffix.buffer).setUint32(0, crc ^ 0xffffffff);
  return [prefix, data, suffix];
}

async function encodeNearestPng(sourceCanvas, width, height) {
  const { width: sourceWidth, height: sourceHeight } = sourceCanvas;
  const { data } = sourceCanvas.getContext("2d").getImageData(0, 0, sourceWidth, sourceHeight);
  const columns = Uint32Array.from({ length: width }, (_, x) => Math.floor((x + 0.5) * sourceWidth / width));
  const stride = width * 4 + 1;
  const batchHeight = 64;
  let top = 0;
  // Write PNG scanlines directly to avoid a second premultiplied canvas
  // round trip changing RGB values in semitransparent pixels.
  const rows = new ReadableStream({
    pull(controller) {
      const end = Math.min(top + batchHeight, height);
      const batch = new Uint8Array((end - top) * stride);
      for (let y = top; y < end; y++) {
        const sourceRow = Math.floor((y + 0.5) * sourceHeight / height) * sourceWidth;
        const row = (y - top) * stride + 1; // PNG filter type 0.
        for (let x = 0; x < width; x++) {
          const from = (sourceRow + columns[x]) * 4;
          const to = row + x * 4;
          batch[to] = data[from];
          batch[to + 1] = data[from + 1];
          batch[to + 2] = data[from + 2];
          batch[to + 3] = data[from + 3];
        }
      }
      controller.enqueue(batch);
      top = end;
      if (top === height) controller.close();
    },
  });
  const compressed = new Uint8Array(await new Response(rows.pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // Bits per channel.
  header[9] = 6; // RGBA.
  return new Blob([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    ...pngChunk("IHDR", header),
    ...pngChunk("IDAT", compressed),
    ...pngChunk("IEND", new Uint8Array()),
  ], { type: "image/png" });
}

async function savePng() {
  const [exportWidth, exportHeight] = exportSize();
  saving = true;
  updateExport();
  const exportName = `${filename.replace(/\.[^.]+$/, "") || "image"}-lowpoly-${exportWidth}x${exportHeight}.png`;
  let failure = "";
  try {
    const blob = await encodeNearestPng(result, exportWidth, exportHeight);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch {
    failure = "PNGを保存できませんでした。解像度か倍率を下げてお試しください。";
  } finally {
    saving = false;
    updateExport();
    if (failure) showMessage("save-error", failure);
  }
}

for (const button of document.querySelectorAll("[data-open]")) {
  button.addEventListener("click", () => fileInput.click());
}
fileInput.addEventListener("change", () => {
  loadImage(fileInput.files[0]);
  fileInput.value = "";
});
const carriesFiles = (event) => event.dataTransfer.types.includes("Files");
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, (event) => {
    if (carriesFiles(event)) event.preventDefault();
  });
}
stage.addEventListener("dragenter", (event) => {
  if (!carriesFiles(event)) return;
  dragDepth++;
  stage.classList.add("dragging");
});
stage.addEventListener("dragleave", (event) => {
  if (!carriesFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) stage.classList.remove("dragging");
});
stage.addEventListener("drop", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  stage.classList.remove("dragging");
  loadImage(event.dataTransfer.files[0]);
});

for (const button of id("presets").querySelectorAll("button")) {
  button.addEventListener("click", () => setLongEdge(Number(button.dataset.size)));
}
longEdge.addEventListener("input", () => setLongEdge(longEdge.valueAsNumber));
for (const input of [widthInput, heightInput]) {
  input.addEventListener("input", editDimensions);
  input.addEventListener("change", editDimensions);
}
function setColorLimit(limit) {
  colorLimit = limit;
  if (limit) colors.value = limit;
  id("color-count").value = limit ? `${limit}色` : "制限なし";
  selectButton(colorPresets, "colors", limit);
  scheduleRender();
}
for (const button of colorPresets.querySelectorAll("button")) {
  button.addEventListener("click", () => setColorLimit(Number(button.dataset.colors)));
}
colors.addEventListener("input", () => setColorLimit(colors.valueAsNumber));
colors.addEventListener("change", () => setColorLimit(colors.valueAsNumber));
resizeMethod.addEventListener("change", scheduleRender);
dither.addEventListener("input", () => {
  id("dither-value").value = `${dither.value}%`;
  scheduleRender();
});
function updateColorLabel(input) {
  const value = input.valueAsNumber;
  const signed = value > 0 ? `+${value}` : String(value);
  input.previousElementSibling.value = input.id === "gamma" ? value.toFixed(2)
    : input.id === "hue" ? `${signed}°` : signed;
}
for (const input of colorInputs) {
  input.addEventListener("input", () => {
    updateColorLabel(input);
    scheduleRender();
  });
}
id("reset-colors").addEventListener("click", () => {
  for (const input of colorInputs) {
    input.value = input.defaultValue;
    updateColorLabel(input);
  }
  scheduleRender();
});
split.addEventListener("input", updateSplit);
new ResizeObserver(fitPreview).observe(stage);
function updateScale() {
  const percent = inputScalePercent();
  if (percent !== null) scalePercent = percent;
  selectButton(id("scales"), "scale", percent === null ? null : percent / 100);
  updateExport();
}
scaleInput.addEventListener("input", updateScale);
scaleInput.addEventListener("change", () => {
  scaleInput.value = (scalePercent / 100).toFixed(2);
  updateScale();
});
for (const button of id("scales").querySelectorAll("button")) {
  button.addEventListener("click", () => {
    scaleInput.value = Number(button.dataset.scale).toFixed(2);
    updateScale();
  });
}
download.addEventListener("click", savePng);
