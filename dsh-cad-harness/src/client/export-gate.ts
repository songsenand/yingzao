// Client side of the risk-annotated export (C1).
//
// A blocked export is not a browser navigation: the server answers 409 JSON,
// this module shows the findings, and only a checked acknowledgement re-requests
// the file with `confirm=1&reason=...`. The server still enforces both.

import { t } from './i18n.ts';

export interface ExportGatePayload {
  kind?: string;
  verdict?: string;
  message?: string;
  findings?: { severity?: string; code?: string; detail?: string }[];
  nextLook?: string[];
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try { return decodeURIComponent(star[1]); } catch { /* fall through */ }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain?.[1] ?? null;
}

function saveBlob(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

function dialog(payload: ExportGatePayload): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483000',
      'background:rgba(16,24,32,.48)', 'display:flex', 'align-items:center',
      'justify-content:center', 'padding:24px',
    ].join(';');

    const panel = document.createElement('div');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.style.cssText = [
      'width:min(560px,100%)', 'max-height:84vh', 'overflow:auto',
      'background:#fff', 'color:#1c2733', 'border-radius:10px',
      'box-shadow:0 24px 80px rgba(0,0,0,.28)', 'padding:20px 22px',
      'font:13px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = t('export.title');
    title.style.cssText = 'font-size:16px;font-weight:650;margin:0 0 6px';
    panel.appendChild(title);

    const verdict = document.createElement('div');
    verdict.textContent = payload.verdict === 'blocked' ? 'BLOCKED' : (payload.verdict ?? 'UNVERIFIED');
    verdict.style.cssText = 'display:inline-block;margin-bottom:10px;padding:2px 8px;border-radius:999px;background:#fdecec;color:#a4262c;font-weight:700;font-size:11px;letter-spacing:.04em';
    panel.appendChild(verdict);

    const message = document.createElement('p');
    message.textContent = t('export.message');
    message.style.cssText = 'margin:0 0 12px;color:#40505f';
    panel.appendChild(message);

    const findings = payload.findings ?? [];
    if (findings.length) {
      const list = document.createElement('ul');
      list.style.cssText = 'margin:0 0 12px;padding:0 0 0 18px;max-height:210px;overflow:auto';
      for (const finding of findings.slice(0, 8)) {
        const item = document.createElement('li');
        item.style.cssText = 'margin:0 0 6px';
        const code = document.createElement('b');
        code.textContent = `${finding.severity ?? 'finding'} · ${finding.code ?? 'unknown'}`;
        code.style.cssText = finding.severity === 'blocked' ? 'color:#a4262c' : 'color:#8a5a00';
        const detail = document.createElement('div');
        detail.textContent = finding.detail ?? '';
        detail.style.cssText = 'color:#5b6b7a;word-break:break-word';
        item.append(code, detail);
        list.appendChild(item);
      }
      if (findings.length > 8) {
        const more = document.createElement('div');
        more.textContent = t('export.more', { count: findings.length - 8 });
        more.style.cssText = 'color:#5b6b7a;margin-bottom:10px';
        panel.appendChild(list);
        panel.appendChild(more);
      } else {
        panel.appendChild(list);
      }
    }

    if (payload.nextLook?.length) {
      const next = document.createElement('div');
      next.style.cssText = 'margin:0 0 12px;padding:8px 10px;border-left:3px solid #c9d3dd;background:#f7f9fb;color:#40505f';
      next.textContent = t('export.next', { items: payload.nextLook.join('; ') });
      panel.appendChild(next);
    }

    const reasonLabel = document.createElement('label');
    reasonLabel.textContent = t('export.reasonLabel');
    reasonLabel.style.cssText = 'display:block;font-weight:600;margin:6px 0 4px';
    const reason = document.createElement('input');
    reason.type = 'text';
    reason.value = t('export.reasonDefault');
    reason.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #ccd5dd;border-radius:6px;font:inherit';
    panel.append(reasonLabel, reason);

    const ackLabel = document.createElement('label');
    ackLabel.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin:12px 0 14px;color:#40505f';
    const ack = document.createElement('input');
    ack.type = 'checkbox';
    ack.style.cssText = 'margin-top:2px';
    const ackText = document.createElement('span');
    ackText.textContent = t('export.ack');
    ackLabel.append(ack, ackText);
    panel.appendChild(ackLabel);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = t('export.cancel');
    cancel.style.cssText = 'padding:7px 14px;border:1px solid #ccd5dd;background:#fff;border-radius:6px;cursor:pointer;font:inherit';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = t('export.confirm');
    confirm.disabled = true;
    confirm.style.cssText = 'padding:7px 14px;border:1px solid #a4262c;background:#a4262c;color:#fff;border-radius:6px;cursor:pointer;font:inherit;opacity:.45';
    actions.append(cancel, confirm);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    ack.focus();

    const close = (value: string | null) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKey);
    cancel.addEventListener('click', () => close(null));
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(null); });
    ack.addEventListener('change', () => {
      confirm.disabled = !ack.checked;
      confirm.style.opacity = ack.checked ? '1' : '.45';
    });
    confirm.addEventListener('click', () => {
      if (ack.checked) close(reason.value.trim() || t('ui.export.defaultReason'));
    });
  });
}

/** Fetch an export; on 409 show the gate and retry only after acknowledgement. */
export async function downloadExport(url: string): Promise<void> {
  try {
    let response = await fetch(url);
    if (response.status === 409) {
      const payload = await response.json().catch(() => ({})) as ExportGatePayload;
      const reason = await dialog(payload);
      if (reason === null) return;
      const retry = new URL(url, window.location.origin);
      retry.searchParams.set('confirm', '1');
      retry.searchParams.set('reason', reason);
      response = await fetch(retry.toString());
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string; hint?: string } };
        if (parsed.error?.code) {
          window.alert(t('export.errorCode', { code: parsed.error.code, hint: parsed.error.hint ?? '' }));
          return;
        }
      } catch { /* not an envelope; show the text */ }
      window.alert(t('export.errorStatus', { status: response.status, detail: text ? `: ${text}` : '' }));
      return;
    }
    const name = filenameFromDisposition(response.headers.get('content-disposition')) ?? 'download';
    saveBlob(await response.blob(), name);
  } catch (error) {
    window.alert(t('export.error', { message: error instanceof Error ? error.message : String(error) }));
  }
}
