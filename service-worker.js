'use strict';

const ACTIVE_DOWNLOADS_KEY = 'movieffmActiveDownloads';
const CONTROL_KEY_PREFIX = 'movieffmDownloadControl_';

function stateKeyForContext(context) {
  return `movieffmDownloadState_${context === 'incognito' ? 'incognito' : 'regular'}`;
}

function controlKeyForContext(context) {
  return `${CONTROL_KEY_PREFIX}${context === 'incognito' ? 'incognito' : 'regular'}`;
}

async function publishContextState(context, state) {
  const key = stateKeyForContext(context);
  const { [key]: previous = {} } = await chrome.storage.local.get(key);
  await chrome.storage.local.set({ [key]: { ...previous, ...state, updatedAt: Date.now() } });
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL('downloader.html');
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (contexts.length) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'downloader.html',
      reasons: ['BLOBS'],
      justification: 'Keep MovieFFM stream downloads and progress alive when the popup closes.',
    });
  } catch (error) {
    if (!/single offscreen document/i.test(String(error?.message || error))) throw error;
  }
}

// An offscreen document can outlive a service-worker wake-up. Close any copy
// from the previous extension load so a reload cannot keep using stale fetch
// settings or downloader code.
chrome.runtime.onInstalled.addListener(() => {
  chrome.offscreen.closeDocument().catch(() => {});
});

async function removeActiveDownload(id) {
  const { [ACTIVE_DOWNLOADS_KEY]: records = {} } = await chrome.storage.local.get(ACTIVE_DOWNLOADS_KEY);
  delete records[String(id)];
  await chrome.storage.local.set({ [ACTIVE_DOWNLOADS_KEY]: records });
  return Object.keys(records).length === 0;
}

chrome.downloads.onChanged.addListener((delta) => {
  (async () => {
    const { [ACTIVE_DOWNLOADS_KEY]: records = {} } = await chrome.storage.local.get(ACTIVE_DOWNLOADS_KEY);
    const record = records[String(delta.id)];
    if (!record) return;

    const received = delta.bytesReceived?.current;
    const total = delta.totalBytes?.current;
    if (Number.isFinite(received) && Number.isFinite(total) && total > 0) {
      await publishContextState(record.context, { ...record, phase: 'downloadingProgress', percent: Math.min(100, Math.round(received / total * 100)) });
    }

    const state = delta.state?.current;
    if (state === 'complete' || state === 'interrupted') {
      if (state === 'complete' || record.stopping) {
        await publishContextState(record.context, {
          ...record,
          phase: state === 'complete' ? 'downloadComplete' : 'downloadStopped',
          percent: state === 'complete' ? 100 : undefined,
          paused: false,
        });
      }
      await removeActiveDownload(delta.id);
    }
  })().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'START_MOVIEFFM_DOWNLOAD') {
    (async () => {
      const context = message.job?.context === 'incognito' ? 'incognito' : 'regular';
      const key = stateKeyForContext(context);
      try {
        const { [key]: previous = {} } = await chrome.storage.local.get(key);
        if (['tryingSource', 'downloadingProgress', 'downloadStarted'].includes(previous.phase)) {
          sendResponse({ ok: false, error: 'downloadInProgress' });
          return;
        }
        await chrome.storage.local.set({ [controlKeyForContext(context)]: { paused: false, stopped: false } });
        const firstSource = message.job?.sources?.[0];
        await publishContextState(context, {
          phase: 'tryingSource',
          title: message.job?.title || 'Movie',
          source: firstSource ? new URL(firstSource.url).hostname : '',
          sourceIndex: firstSource?.sourceIndex,
          sourceLabel: firstSource?.sourceLabel || '',
          current: 1,
          total: message.job?.sources?.length || 0,
          percent: 0,
          failureReason: '',
        });
        await ensureOffscreenDocument();
        const { [controlKeyForContext(context)]: controlState = {} } = await chrome.storage.local.get(controlKeyForContext(context));
        await chrome.runtime.sendMessage({ type: 'RUN_MOVIEFFM_DOWNLOAD', job: { ...message.job, controlState } });
        sendResponse({ ok: true });
      } catch {
        await publishContextState(context, { phase: 'downloadFailed' }).catch(() => {});
        sendResponse({ ok: false, error: 'downloadFailed' });
      }
    })();
    return true;
  }

  if (message?.type === 'MOVIEFFM_PUBLISH_STATE') {
    publishContextState(message.context, message.state).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'MOVIEFFM_START_FILE_DOWNLOAD') {
    (async () => {
      try {
        const id = await chrome.downloads.download({ url: message.url, filename: message.filename, conflictAction: 'uniquify' });
        const { [ACTIVE_DOWNLOADS_KEY]: records = {} } = await chrome.storage.local.get(ACTIVE_DOWNLOADS_KEY);
        const record = {
          context: message.context === 'incognito' ? 'incognito' : 'regular',
          title: message.title || 'Movie',
          source: message.source || '',
          sourceIndex: message.sourceIndex,
          sourceLabel: message.sourceLabel || '',
          current: message.current || 0,
          total: message.total || 0,
        };
        records[String(id)] = record;
        await chrome.storage.local.set({ [ACTIVE_DOWNLOADS_KEY]: records });
        const controlKey = controlKeyForContext(record.context);
        const { [controlKey]: control = {} } = await chrome.storage.local.get(controlKey);
        if (control.stopped) {
          record.stopping = true;
          records[String(id)] = record;
          await chrome.storage.local.set({ [ACTIVE_DOWNLOADS_KEY]: records });
          await chrome.downloads.cancel(id).catch(() => {});
        } else if (control.paused) {
          await chrome.downloads.pause(id).catch(() => {});
        }
        await publishContextState(record.context, { ...record, phase: 'downloadStarted', percent: 0 });
        const [item] = await chrome.downloads.search({ id });
        if (item?.totalBytes > 0) {
          await publishContextState(record.context, { ...record, phase: 'downloadingProgress', percent: Math.min(100, Math.round(item.bytesReceived / item.totalBytes * 100)) });
        }
        if (item?.state === 'complete' || (item?.state === 'interrupted' && record.stopping)) {
          await publishContextState(record.context, {
            ...record,
            phase: item.state === 'complete' ? 'downloadComplete' : 'downloadStopped',
            percent: item.state === 'complete' ? 100 : undefined,
            paused: false,
          });
          await removeActiveDownload(id);
        }
        sendResponse({ ok: true, id });
      } catch {
        sendResponse({ ok: false, error: 'downloadFailed' });
      }
    })();
    return true;
  }

  if (message?.type === 'MOVIEFFM_GET_FILE_DOWNLOAD') {
    (async () => {
      try {
        const [item] = await chrome.downloads.search({ id: Number(message.id) });
        if (!item) {
          sendResponse({ ok: false, error: 'downloadFailed' });
          return;
        }
        sendResponse({ ok: true, state: item.state, error: item.error || '' });
      } catch {
        sendResponse({ ok: false, error: 'downloadFailed' });
      }
    })();
    return true;
  }

  if (message?.type === 'MOVIEFFM_CONTROL_DOWNLOAD') {
    (async () => {
      const context = message.context === 'incognito' ? 'incognito' : 'regular';
      const action = message.action;
      if (!['pause', 'resume', 'stop'].includes(action)) {
        sendResponse({ ok: false, error: 'downloadControlFailed' });
        return;
      }
      try {
        const controlKey = controlKeyForContext(context);
        const control = action === 'pause'
          ? { paused: true, stopped: false }
          : action === 'resume'
            ? { paused: false, stopped: false }
            : { paused: false, stopped: true };
        await chrome.storage.local.set({ [controlKey]: control });

        const { [ACTIVE_DOWNLOADS_KEY]: records = {} } = await chrome.storage.local.get(ACTIVE_DOWNLOADS_KEY);
        const matches = Object.entries(records).filter(([, record]) => (record.context === 'incognito' ? 'incognito' : 'regular') === context);
        if (action === 'stop') {
          for (const [id, record] of matches) records[id] = { ...record, stopping: true };
          if (matches.length) await chrome.storage.local.set({ [ACTIVE_DOWNLOADS_KEY]: records });
        }

        try { await chrome.runtime.sendMessage({ type: 'MOVIEFFM_DOWNLOAD_CONTROL', context, action }); } catch {}

        if (action === 'pause') {
          await Promise.allSettled(matches.map(([id]) => chrome.downloads.pause(Number(id))));
          await publishContextState(context, { paused: true });
        } else if (action === 'resume') {
          await Promise.allSettled(matches.map(([id]) => chrome.downloads.resume(Number(id))));
          await publishContextState(context, { paused: false });
        } else {
          await Promise.allSettled(matches.map(([id]) => chrome.downloads.cancel(Number(id))));
        }
        sendResponse({ ok: true });
      } catch {
        sendResponse({ ok: false, error: 'downloadControlFailed' });
      }
    })();
    return true;
  }

  if (message?.type === 'MOVIEFFM_DOWNLOAD_FINISHED') {
    chrome.offscreen.closeDocument().catch(() => {});
  }

  return false;
});

