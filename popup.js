'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  const title = document.getElementById('popupTitle');
  const openSiteButton = document.getElementById('openSiteBtn');
  const openSiteLabel = document.getElementById('openSiteLabel');
  const label = document.getElementById('downloadLabel');
  const button = document.getElementById('downloadBtn');
  const controlRow = document.getElementById('downloadControlRow');
  const pauseResumeButton = document.getElementById('pauseResumeBtn');
  const stopButton = document.getElementById('stopBtn');
  const status = document.getElementById('status');
  const track = document.getElementById('progressTrack');
  const bar = document.getElementById('progressBar');
  const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;
  const context = chrome.extension.inIncognitoContext ? 'incognito' : 'regular';
  const stateKey = `movieffmDownloadState_${context}`;
  let currentState = null;
  title.textContent = t('extName');
  openSiteLabel.textContent = t('openSiteButton');
  label.textContent = t('downloadButton');
  stopButton.textContent = t('stopButton');

  function render(state) {
    currentState = state || null;
    const activePhases = ['readingSources', 'requestingPermission', 'tryingSource', 'downloadingProgress', 'downloadStarted'];
    const isActive = activePhases.includes(state?.phase);
    button.hidden = isActive;
    controlRow.hidden = !isActive;
    pauseResumeButton.textContent = state?.paused ? t('resumeButton') : t('pauseButton');
    pauseResumeButton.disabled = !isActive;
    stopButton.disabled = !isActive;
    if (!state?.phase) {
      button.disabled = false;
      report(t('readyHint'));
      track.hidden = true;
      bar.style.width = '0%';
      return;
    }
    button.disabled = isActive;
    const percent = state.phase === 'downloadComplete' ? 100 : Math.max(0, Math.min(100, Number(state.percent) || 0));
    if (state.title) {
      const sourceNumber = state.current && state.total ? `${state.current}/${state.total} · ` : '';
      const siteSourceLabel = state.sourceLabel || (Number.isInteger(Number(state.sourceIndex)) ? `片源${Number(state.sourceIndex) + 1}` : '');
      const sourceName = state.source || t('waitingSource');
      const lines = [
        `${t('downloadingTitleLabel')} ${state.title}`,
        `${t('sourceLabel')} ${siteSourceLabel ? `${siteSourceLabel} · ` : ''}${sourceNumber}${sourceName}`,
        `${t('progressLabel')} ${percent}%`,
      ];
      const errors = ['downloadInterrupted', 'allSourcesFailed', 'noPage', 'wrongPage', 'noSources', 'permissionDenied', 'downloadFailed'];
      const terminal = [...errors, 'downloadComplete', 'downloadStopped'];
      if (terminal.includes(state.phase)) lines.push(t(state.phase));
      if (state.phase === 'allSourcesFailed' && state.failureReason) lines.push(`${t('failureReasonLabel')} ${state.failureReason}`);
      report(lines.join('\n'), state.phase === 'downloadComplete' ? 'ok' : errors.includes(state.phase) ? 'error' : '');
      track.hidden = !['downloadStarted', 'downloadingProgress', 'downloadComplete'].includes(state.phase);
      bar.style.width = `${percent}%`;
    } else if (state.phase === 'tryingSource') {
      report(t(state.phase, [String(state.current), String(state.total), String(state.elapsedSeconds || 0)]));
      track.hidden = true;
    } else if (state.phase === 'downloadingProgress') {
      report(t(state.phase, [String(percent)]));
      track.hidden = false;
      bar.style.width = `${percent}%`;
    } else if (state.phase === 'downloadComplete') {
      report(t(state.phase), 'ok');
      track.hidden = false;
      bar.style.width = '100%';
    } else {
      report(t(state.phase), state.phase === 'downloadStarted' ? 'ok' : 'error');
      track.hidden = state.phase !== 'downloadStarted';
    }
  }

  function report(message, kind = '') {
    status.textContent = message;
    if (kind) status.dataset.kind = kind;
    else delete status.dataset.kind;
  }

  async function clearStaleDownloadState(state) {
    const terminalPhases = ['downloadComplete', 'downloadStopped', 'allSourcesFailed', 'downloadInterrupted', 'noPage', 'wrongPage', 'noSources', 'permissionDenied', 'downloadFailed'];
    if (terminalPhases.includes(state?.phase)) {
      await chrome.storage.local.remove(stateKey);
      return null;
    }
    if (!['readingSources', 'requestingPermission', 'tryingSource', 'downloadingProgress', 'downloadStarted'].includes(state?.phase)) return state;
    try {
      const downloaderUrl = chrome.runtime.getURL('downloader.html');
      const [contexts, { movieffmActiveDownloads: records = {} }, inProgress] = await Promise.all([
        chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [downloaderUrl] }),
        chrome.storage.local.get('movieffmActiveDownloads'),
        chrome.downloads.search({ state: 'in_progress' }),
      ]);
      const activeIds = new Set(inProgress.map(item => String(item.id)));
      const hasTrackedDownload = Object.entries(records).some(([id, record]) =>
        record.context === context && activeIds.has(id));
      let downloaderStatus = null;
      if (contexts.length) {
        downloaderStatus = await chrome.runtime.sendMessage({ type: 'MOVIEFFM_GET_DOWNLOADER_STATUS' });
      }
      const downloaderIsBusy = downloaderStatus?.busy && downloaderStatus.context === context;
      if (downloaderIsBusy || hasTrackedDownload) return state;
      await chrome.storage.local.remove(stateKey);
      return null;
    } catch {
      // Keep the displayed state if Chrome cannot verify the active job.
      return state;
    }
  }

  async function sendDownloadControl(action) {
    pauseResumeButton.disabled = true;
    stopButton.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'MOVIEFFM_CONTROL_DOWNLOAD', context, action });
      if (!response?.ok) report(t(response?.error || 'downloadControlFailed'), 'error');
    } catch {
      report(t('downloadControlFailed'), 'error');
    } finally {
      if (!controlRow.hidden) {
        pauseResumeButton.disabled = false;
        stopButton.disabled = false;
      }
    }
  }

  pauseResumeButton.addEventListener('click', () => sendDownloadControl(currentState?.paused ? 'resume' : 'pause'));
  stopButton.addEventListener('click', () => sendDownloadControl('stop'));

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[stateKey]) render(changes[stateKey].newValue);
  });
  const stateResult = await chrome.storage.local.get(stateKey);
  render(await clearStaleDownloadState(stateResult[stateKey]));

  openSiteButton.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.mvffm.net/' }).catch(() => report(t('openSiteFailed'), 'error'));
  });

  async function extractPage(forceSourceScan = false) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) throw new Error('noPage');
    const page = new URL(tab.url);
    if (!/(^|\.)mvffm\.net$/i.test(page.hostname)) throw new Error('wrongPage');
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [forceSourceScan],
      func: forceSourceScan => {
        const title = document.querySelector('h1')?.textContent?.trim() || document.title.replace(/\s*-\s*Movieffm.*$/i, '').trim() || 'Movie';
        const matches = [];
        const parse = value => { try { const list = JSON.parse(value); if (Array.isArray(list)) matches.push(...list); } catch {} };
        for (const script of document.scripts) {
          const match = (script.textContent || '').match(/videourls\s*:\s*(\[.*?\])\s*,\s*isActive/s);
          if (match) parse(match[1].replace(/\\\//g, '/'));
        }
        const vue = document.querySelector('#playcontainer')?.__vue__;
        if (Array.isArray(vue?.videourls)) matches.push(...vue.videourls);
        const unique = new Map();
        const addSource = (value, type, sourceIndex) => {
          if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return;
          const url = value.replace(/\\\//g, '/');
          const inferredType = /\.mp4(?:$|[?#])/i.test(url) ? 'mp4' : /\.flv(?:$|[?#])/i.test(url) ? 'flv' : 'hls';
          if (!unique.has(url)) unique.set(url, { url, type: type || inferredType, sourceIndex });
          else if ((unique.get(url).sourceIndex === undefined || unique.get(url).sourceIndex === null) && sourceIndex !== undefined && sourceIndex !== null) {
            unique.get(url).sourceIndex = sourceIndex;
          }
        };
        const activeVideos = [...document.querySelectorAll('video')]
          .filter(video => !video.ended && (!video.paused || video.currentTime > 0));
        const selectedOption = document.querySelector('#playeroptionsul .dooplay_player_option.on');
        const selectedOptionLabel = selectedOption?.innerText?.replace(/\s+/g, '').trim() || '';

        // MovieFFM keeps the selected player source separately from its full
        // source list. Put that selected URL first so a played video is reused
        // before the downloader falls back to the other sources.
        const vueSources = [...(vue?.videourls || []), ...matches];
        const selectedUrl = typeof vue?.videourl === 'string' ? vue.videourl.replace(/\\\//g, '/') : '';
        const activeSourceIds = [vue?.isActive, vue?.watch?.source, vue?.tbcur]
          .filter(value => value !== undefined && value !== null)
          .map(value => String(value));
        const activeSource = vueSources.find(item => item && item.url === selectedUrl)
          || activeSourceIds.map(id => vueSources.find(item => item && String(item.source) === id)).find(Boolean);
        if (activeSource) addSource(activeSource.url, activeSource.type, activeSource.source);
        if (['hls', 'mp4', 'flv'].includes(vue?.type)) {
          addSource(vue.videourl, vue.type, activeSource?.source ?? activeSourceIds[0]);
        }
        for (const video of activeVideos) addSource(video.currentSrc || video.src);

        if (activeVideos.some(video => /^(?:blob:|)$/.test(video.currentSrc || video.src))) {
          const mediaRequests = performance.getEntriesByType('resource')
            .map(entry => entry.name)
            .filter(url => /^https?:\/\//i.test(url) && /\.(?:m3u8|mp4|flv)(?:$|[?#])/i.test(url))
            .reverse();
          for (const url of mediaRequests) addSource(url, /\.flv(?:$|[?#])/i.test(url) ? 'flv' : undefined);
        }

        for (const item of matches) {
          if (item) addSource(item.url, item.type, item.source);
        }
        const sources = [...unique.values()];
        const selectedPlaybackSource = (selectedUrl && unique.get(selectedUrl))
          || (activeSource?.url && unique.get(activeSource.url))
          || activeVideos.map(video => unique.get(video.currentSrc || video.src)).find(Boolean);
        const playbackHasStarted = activeVideos.some(video => video.currentTime > 0);
        if (selectedPlaybackSource && selectedOptionLabel) selectedPlaybackSource.sourceLabel = selectedOptionLabel;
        const permissionOrigins = [...new Set([
          ...sources.map(source => new URL(source.url).origin),
          ...[...document.querySelectorAll('iframe')].map(frame => frame.src).filter(url => /^https?:\/\//i.test(url)).map(url => new URL(url).origin),
        ])].map(origin => `${origin}/*`);
        return {
          title,
          sources: playbackHasStarted && selectedPlaybackSource && !forceSourceScan ? [selectedPlaybackSource] : sources,
          permissionOrigins,
        };
      }
    });
    return { ...result, tabId: tab.id };
  }

  async function capturePlayedFrameSource(tabId, sourceLabel) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        args: [Boolean(sourceLabel?.includes('FLV'))],
        func: preferFlv => {
          const videos = [...document.querySelectorAll('video')].filter(video => !video.ended && video.currentTime > 0);
          if (!videos.length) return null;
          const direct = videos.map(video => video.currentSrc || video.src).filter(url => /^https?:\/\//i.test(url));
          const entries = performance.getEntriesByType('resource');
          const media = entries.map(entry => entry.name)
            .filter(url => /^https?:\/\//i.test(url) && /\.(?:m3u8|mp4|flv)(?:$|[?#])/i.test(url));
          const hls = window._hls;
          const hlsManifests = [
            hls?.url,
            ...(Array.isArray(hls?.levels) ? hls.levels.flatMap(level => Array.isArray(level.url) ? level.url : [level.url]) : []),
          ].filter(url => typeof url === 'string' && /^https?:\/\//i.test(url) && /\.m3u8(?:$|[?#])/i.test(url));
          const flv = media.filter(url => /\.flv(?:$|[?#])/i.test(url));
          const playlist = media.filter(url => /\.m3u8(?:$|[?#])/i.test(url));
          const mp4 = media.filter(url => /\.mp4(?:$|[?#])/i.test(url));
          const urls = preferFlv
            ? [...new Set([...flv.reverse(), ...hlsManifests.reverse(), ...playlist.reverse(), ...direct.reverse(), ...mp4.reverse()])]
            : [...new Set([...hlsManifests.reverse(), ...playlist.reverse(), ...mp4.reverse(), ...direct.reverse(), ...flv.reverse()])];
          const seen = new Set();
          return [...urls].filter(url => !seen.has(url) && seen.add(url)).map(url => ({
            url,
            explicitFlv: /\.flv(?:$|[?#])/i.test(url),
            type: /\.flv(?:$|[?#])/i.test(url) ? 'flv' : /\.mp4(?:$|[?#])/i.test(url) ? 'mp4' : 'hls',
          }));
        },
      });
      const candidates = results.flatMap(result => Array.isArray(result.result) ? result.result : []);
      if (!candidates.length) return null;
      const preferred = sourceLabel?.includes('FLV')
        ? candidates.find(source => source.explicitFlv) || candidates.find(source => source.type === 'flv')
        : null;
      return { ...(preferred || candidates[0]), sourceLabel };
    } catch {
      return null;
    }
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    track.hidden = true;
    bar.style.width = '0%';
    report(t('readingSources'));
    try {
      const forceSourceScan = ['allSourcesFailed', 'downloadInterrupted', 'downloadFailed'].includes(currentState?.phase);
      const page = await extractPage(forceSourceScan);
      if (!page.sources.length) throw new Error('noSources');
      const origins = page.permissionOrigins || [...new Set(page.sources.map(source => new URL(source.url).origin + '/*'))];
      report(t('requestingPermission'));
      const permitted = await chrome.permissions.request({ origins });
      if (!permitted) throw new Error('permissionDenied');
      const frameSource = await capturePlayedFrameSource(page.tabId, page.sources[0]?.sourceLabel);
      if (frameSource) page.sources = [frameSource];
      page.context = context;
      const response = await chrome.runtime.sendMessage({ type: 'START_MOVIEFFM_DOWNLOAD', job: page });
      if (!response?.ok) throw new Error(response?.error || 'downloadFailed');
    } catch (error) {
      const key = ['noPage', 'wrongPage', 'noSources', 'permissionDenied', 'downloadInProgress'].includes(error?.message) ? error.message : 'downloadFailed';
      button.disabled = false;
      report(t(key), 'error');
      track.hidden = true;
    }
  });
});
