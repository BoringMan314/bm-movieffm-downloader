'use strict';

let busy = false;
let currentContext = 'regular';
let currentTitle = '';
let currentSource = '';
let currentSourceIndex;
let currentSourceLabel = '';
let currentIndex = 0;
let currentTotal = 0;
let pauseRequested = false;
let stopRequested = false;
let activeFetchController = null;
const pendingControls = {};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntilResumed() {
  while (pauseRequested && !stopRequested) await sleep(150);
  if (stopRequested) throw new Error('downloadStopped');
}

async function publish(state) {
  await chrome.runtime.sendMessage({
    type: 'MOVIEFFM_PUBLISH_STATE',
    context: currentContext,
    state: {
      title: currentTitle,
      source: currentSource,
      sourceIndex: currentSourceIndex,
      sourceLabel: currentSourceLabel,
      current: currentIndex,
      total: currentTotal,
      paused: pauseRequested,
      ...state,
    },
  });
}

async function setProgress(done, total) {
  const percent = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
  await publish({ phase: 'downloadingProgress', percent });
}

async function fetchWithTimeout(url, timeoutMs, consume) {
  while (true) {
    await waitUntilResumed();
    const controller = new AbortController();
    activeFetchController = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { credentials: 'omit', redirect: 'follow', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return consume ? await consume(response) : response;
    } catch (error) {
      if (stopRequested || controller.signal.reason === 'stopped') throw new Error('downloadStopped');
      if (pauseRequested || controller.signal.reason === 'paused') {
        await waitUntilResumed();
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (activeFetchController === controller) activeFetchController = null;
    }
  }
}

async function fetchText(url) {
  return fetchWithTimeout(url, 15_000, response => response.text());
}

async function playlistFor(url, depth = 0) {
  if (depth > 3) throw new Error('playlistDepth');
  const text = await fetchText(url);
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('notPlaylist');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:') && lines[i + 1] && !lines[i + 1].startsWith('#')) {
      variants.push({ url: new URL(lines[i + 1], url).href, bandwidth: Number(lines[i].match(/BANDWIDTH=(\d+)/i)?.[1] || 0) });
    }
  }
  if (variants.length) {
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return playlistFor(variants[0].url, depth + 1);
  }
  const segments = [];
  let init = null;
  let sequence = 0;
  let currentKey = null;
  const sequenceIv = value => {
    const iv = new Uint8Array(16);
    let number = BigInt(value);
    for (let i = 15; i >= 0; i--) {
      iv[i] = Number(number & 255n);
      number >>= 8n;
    }
    return iv;
  };
  const parseIv = value => {
    if (!value) return null;
    const hex = value.replace(/^0x/i, '');
    if (!/^[\da-f]{1,32}$/i.test(hex)) throw new Error('invalidEncryptionIv');
    return Uint8Array.from(hex.padStart(32, '0').match(/.{2}/g), byte => parseInt(byte, 16));
  };
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequence = Number(line.slice(line.indexOf(':') + 1)) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const method = line.match(/METHOD=([^,]+)/i)?.[1]?.trim();
      if (method === 'NONE') {
        currentKey = null;
      } else if (method === 'AES-128') {
        const uri = line.match(/URI="([^"]+)"/i)?.[1];
        if (!uri || /KEYFORMAT="(?!identity)/i.test(line)) throw new Error('unsupportedEncryption');
        currentKey = { url: new URL(uri, url).href, iv: parseIv(line.match(/IV=([^,]+)/i)?.[1]) };
      } else {
        throw new Error('unsupportedEncryption');
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const uri = line.match(/URI="([^"]+)"/i)?.[1];
      if (uri) init = { url: new URL(uri, url).href, key: currentKey && { ...currentKey, iv: currentKey.iv || sequenceIv(sequence) } };
    } else if (!line.startsWith('#')) {
      segments.push({
        url: new URL(line, url).href,
        key: currentKey && { ...currentKey, iv: currentKey.iv || sequenceIv(sequence) },
      });
      sequence++;
    }
  }
  if (!segments.length) throw new Error('emptyPlaylist');
  const usesMp4 = Boolean(init) || segments.some(segment => /\.(?:mp4|m4s)(?:$|[?#])/i.test(segment.url));
  return { segments, init, extension: usesMp4 ? 'mp4' : 'ts' };
}

async function fetchBinary(url) {
  return fetchWithTimeout(url, 30_000, response => response.arrayBuffer());
}

async function fetchPlaylistFile(file, keyCache) {
  const data = await fetchBinary(file.url);
  if (!file.key) return data;
  let key = keyCache.get(file.key.url);
  if (!key) {
    const rawKey = await fetchBinary(file.key.url);
    if (rawKey.byteLength !== 16) throw new Error('invalidEncryptionKey');
    key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, ['decrypt']);
    keyCache.set(file.key.url, key);
  }
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: file.key.iv }, key, data);
}

function safeFilename(name, extension) {
  const clean = (name || 'Movie').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Movie';
  const sourceNumber = Number(currentSourceIndex);
  const hasSourceIndex = currentSourceIndex !== undefined && currentSourceIndex !== null && currentSourceIndex !== '' && Number.isInteger(sourceNumber);
  const recommendationNumber = currentSourceLabel.match(/\d+/)?.[0];
  const sourceSuffix = recommendationNumber || (hasSourceIndex ? sourceNumber + 1 : currentIndex);
  return `${clean}_片源${sourceSuffix}.${extension}`;
}

async function startFileDownload(url, filename) {
  const response = await chrome.runtime.sendMessage({
    type: 'MOVIEFFM_START_FILE_DOWNLOAD',
    context: currentContext,
    title: currentTitle,
    source: currentSource,
    sourceIndex: currentSourceIndex,
    sourceLabel: currentSourceLabel,
    current: currentIndex,
    total: currentTotal,
    url,
    filename,
  });
  if (!response?.ok) throw new Error(response?.error || 'downloadFailed');
  return response.id;
}

async function waitForFileDownload(id) {
  while (true) {
    await waitUntilResumed();
    const response = await chrome.runtime.sendMessage({ type: 'MOVIEFFM_GET_FILE_DOWNLOAD', id });
    if (!response?.ok) throw new Error('downloadFailed');
    if (response.state === 'complete') return;
    if (response.state === 'interrupted') {
      if (response.error === 'USER_CANCELED') throw new Error('downloadCancelled');
      throw new Error('downloadInterrupted');
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function downloadSource(source, name, onResolved) {
  if (/\.(?:mp4|flv)(?:$|[?#])/i.test(source.url) || ['mp4', 'flv'].includes(source.type)) {
    await waitUntilResumed();
    const extension = source.type === 'flv' || /\.flv(?:$|[?#])/i.test(source.url) ? 'flv' : 'mp4';
    const id = await startFileDownload(source.url, safeFilename(name, extension));
    onResolved();
    await waitForFileDownload(id);
    return;
  }

  const playlist = await playlistFor(source.url);
  onResolved();
  const allSegments = playlist.init ? [playlist.init, ...playlist.segments] : playlist.segments;
  if (allSegments.length > 12000) throw new Error('tooManySegments');

  // Keep each source isolated: a failed source's partial segments are discarded
  // before runDownload starts the next source.
  const parts = [];
  let totalBytes = 0;
  const keyCache = new Map();
  await setProgress(0, allSegments.length);
  for (let i = 0; i < allSegments.length; i++) {
    const data = await fetchPlaylistFile(allSegments[i], keyCache);
    totalBytes += data.byteLength;
    if (totalBytes > 1500 * 1024 * 1024) throw new Error('tooLarge');
    parts.push(data);
    await setProgress(i + 1, allSegments.length);
  }

  const blob = new Blob(parts, { type: playlist.extension === 'mp4' ? 'video/mp4' : 'video/mp2t' });
  const objectUrl = URL.createObjectURL(blob);
  try {
    await waitUntilResumed();
    const id = await startFileDownload(objectUrl, safeFilename(name, playlist.extension));
    await waitForFileDownload(id);
    URL.revokeObjectURL(objectUrl);
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function runDownload(job) {
  if (busy) return;
  busy = true;
  currentContext = job.context === 'incognito' ? 'incognito' : 'regular';
  currentTitle = job.title || 'Movie';
  currentTotal = job.sources.length;
  let lastError = '';
  const queuedAction = pendingControls[currentContext];
  delete pendingControls[currentContext];
  const initialAction = queuedAction || (job.controlState?.stopped ? 'stop' : job.controlState?.paused ? 'pause' : '');
  pauseRequested = initialAction === 'pause';
  stopRequested = initialAction === 'stop';
  try {
    if (stopRequested) {
      await publish({ phase: 'downloadStopped', paused: false });
      chrome.runtime.sendMessage({ type: 'MOVIEFFM_DOWNLOAD_FINISHED' }).catch(() => {});
      return;
    }
    for (let i = 0; i < job.sources.length; i++) {
      const current = i + 1;
      currentIndex = current;
      currentSource = new URL(job.sources[i].url).hostname;
      currentSourceIndex = job.sources[i].sourceIndex;
      currentSourceLabel = job.sources[i].sourceLabel || '';
      const startedAt = Date.now();
      let resolved = false;
      let timer;
      const onResolved = () => {
        resolved = true;
        clearInterval(timer);
      };
      await publish({ phase: 'tryingSource', current, total: job.sources.length, elapsedSeconds: 0, percent: 0 });
      timer = setInterval(() => {
        if (!resolved) {
          publish({ phase: 'tryingSource', current, total: job.sources.length, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) });
        }
      }, 1000);
      try {
        await downloadSource(job.sources[i], job.title, onResolved);
        chrome.runtime.sendMessage({ type: 'MOVIEFFM_DOWNLOAD_FINISHED' }).catch(() => {});
        return;
      } catch (error) {
        onResolved();
        lastError = error?.message || 'downloadFailed';
        if (stopRequested || error?.message === 'downloadStopped') {
          await publish({ phase: 'downloadStopped', paused: false });
          chrome.runtime.sendMessage({ type: 'MOVIEFFM_DOWNLOAD_FINISHED' }).catch(() => {});
          return;
        }
        if (error?.message === 'downloadCancelled') {
          await publish({ phase: 'downloadInterrupted' });
          chrome.runtime.sendMessage({ type: 'MOVIEFFM_DOWNLOAD_FINISHED' }).catch(() => {});
          return;
        }
      } finally {
        clearInterval(timer);
      }
    }
    await publish({ phase: 'allSourcesFailed', percent: 0, failureReason: lastError });
    chrome.runtime.sendMessage({ type: 'MOVIEFFM_DOWNLOAD_FINISHED' }).catch(() => {});
  } finally {
    busy = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'MOVIEFFM_GET_DOWNLOADER_STATUS') {
    sendResponse({ busy, context: currentContext });
    return true;
  }
  if (message?.type === 'RUN_MOVIEFFM_DOWNLOAD') runDownload(message.job);
  if (message?.type === 'MOVIEFFM_DOWNLOAD_CONTROL') {
    const context = message.context === 'incognito' ? 'incognito' : 'regular';
    if (!busy || context !== currentContext) {
      pendingControls[context] = message.action;
      return;
    }
    if (message.action === 'pause') {
      pauseRequested = true;
      activeFetchController?.abort('paused');
    } else if (message.action === 'resume') {
      pauseRequested = false;
    } else if (message.action === 'stop') {
      stopRequested = true;
      pauseRequested = false;
      activeFetchController?.abort('stopped');
    }
  }
});
