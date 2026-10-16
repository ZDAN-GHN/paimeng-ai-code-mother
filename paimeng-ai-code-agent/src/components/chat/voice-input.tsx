'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, Tooltip } from 'antd';
import { AudioOutlined, DeleteOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { z } from 'zod';

/**
 * 语音输入：点击开始录音（MediaRecorder），再点结束，录音上传到 `POST app/chat/transcribe` 转写成文字，
 * 追加到输入框（不自动发送）。转写别名 `speech.transcribe` 没配置时按钮禁用并说明原因。
 *
 * 这里只有一条录音状态机：idle → starting → recording → transcribing →（failed 可重试，保留录音）。
 */

/** 录音上限：到点自动结束并转写（服务端另有 10 MiB 字节上限）。 */
export const maxRecordingSeconds = 120;
/** 优先带 opus 的 webm，其次容器默认，最后 ogg（老 Firefox）。都不支持时交给浏览器自选。 */
export const preferredAudioMimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'] as const;

const audioExtensions: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

/** 选中浏览器支持的首选录音格式；都不支持返回 null，让 MediaRecorder 自己选。 */
export function chooseAudioMimeType(isTypeSupported: (mimeType: string) => boolean): string | null {
  return preferredAudioMimeTypes.find(type => isTypeSupported(type)) ?? null;
}

/** 录音文件名扩展名；服务端在声明类型缺失时按扩展名兜底，所以要和容器对得上。 */
export function audioFileExtension(mimeType: string): string {
  return audioExtensions[mimeType.split(';')[0]?.trim().toLowerCase() ?? ''] ?? 'webm';
}

/** 把转写文本追加到已有输入后面，用空格分隔；已有内容以空白结尾或已有内容为空时不重复加空格。 */
export function appendTranscript(existing: string, transcript: string): string {
  const text = transcript.trim();
  if (!text) return existing;
  if (!existing) return text;
  return /\s$/.test(existing) ? existing + text : `${existing} ${text}`;
}

/** 录音计时：m:ss。 */
export function formatRecordingTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** 麦克风失败的可读原因；都失败在明面上，不静默。 */
export function microphoneError(cause: unknown): string {
  const name = cause instanceof DOMException ? cause.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '浏览器未授权使用麦克风';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到可用的麦克风';
  return `无法访问麦克风：${cause instanceof Error ? cause.message : '未知错误'}`;
}

/** 麦克风按钮禁用的原因；可用时返回 null。 */
export function voiceUnavailableReason(input: { editable: boolean; serverEnabled: boolean; recorderSupported: boolean }): string | null {
  if (!input.editable) return '当前不可编辑，无法使用语音输入';
  if (!input.serverEnabled) return '未配置语音转写模型：请在模型管理里新增别名 speech.transcribe（OpenAI 兼容的 /audio/transcriptions）';
  if (!input.recorderSupported) return '当前浏览器不支持录音（需要 MediaRecorder）';
  return null;
}

const transcribeResultSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  // 失败响应是 `data: null`（http.ts 的 failure 包装），所以这里用 nullish。
  data: z.object({ text: z.string() }).nullish(),
});

/** 录音上传走 FormData（`src/client/api.ts` 只做 JSON）；失败时把服务端文案原样抛出。 */
export async function transcribeAudio(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append('audio', blob, `recording.${audioFileExtension(blob.type)}`);
  let response: Response;
  try {
    response = await fetch('/api/app/chat/transcribe', { method: 'POST', body: form, credentials: 'same-origin' });
  } catch {
    throw new Error('语音转写失败：网络错误');
  }
  const payload = transcribeResultSchema.safeParse(await response.json().catch(() => null));
  if (!payload.success) throw new Error(response.ok ? '语音转写失败：响应格式不正确' : `语音转写失败（HTTP ${response.status}）`);
  if (payload.data.code !== 0 || !payload.data.data) throw new Error(payload.data.message || `语音转写失败（HTTP ${response.status}）`);
  return payload.data.data.text;
}

type VoicePhase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'failed';

export function VoiceInput({ editable, serverEnabled, onTranscript }: {
  /** 输入框可用（本人且已加载）；false 时按钮禁用并说明原因。 */
  editable: boolean;
  /** 服务端是否配置了转写别名（GET app/chat/transcribe）。 */
  serverEnabled: boolean;
  onTranscript: (text: string) => void;
}) {
  const [recorderSupported, setRecorderSupported] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const discard = useRef(false);
  const recorded = useRef<Blob | null>(null);

  useEffect(() => {
    setRecorderSupported(typeof MediaRecorder !== 'undefined');
    return () => {
      // 卸载时收尾：关麦克风、停计时，并标记丢弃，避免离开页面后还把录音传到转写接口。
      discard.current = true;
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
      stream.current?.getTracks().forEach(track => track.stop());
      stream.current = null;
      if (timer.current !== null) clearInterval(timer.current);
    };
  }, []);

  const reason = voiceUnavailableReason({ editable, serverEnabled, recorderSupported });

  function clearTimer() {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }

  function closeStream() {
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
  }

  async function upload(blob: Blob) {
    setPhase('transcribing');
    setError('');
    try {
      const text = await transcribeAudio(blob);
      if (!text.trim()) {
        setPhase('failed');
        setError('没有识别到语音内容，可以重试或丢弃');
        return;
      }
      recorded.current = null;
      setSeconds(0);
      setPhase('idle');
      onTranscript(text);
    } catch (cause) {
      // 录音留在 recorded 里，失败后可重试，不丢用户的录音。
      setPhase('failed');
      setError(cause instanceof Error ? cause.message : '语音转写失败');
    }
  }

  function finished(blob: Blob) {
    closeStream();
    clearTimer();
    recorder.current = null;
    chunks.current = [];
    if (discard.current) {
      discard.current = false;
      recorded.current = null;
      setSeconds(0);
      setPhase('idle');
      return;
    }
    recorded.current = blob;
    void upload(blob);
  }

  function stopRecording(drop = false) {
    discard.current = drop;
    const current = recorder.current;
    if (current && current.state !== 'inactive') {
      current.stop();
      return;
    }
    if (drop) {
      closeStream();
      clearTimer();
      setSeconds(0);
      setPhase('idle');
    }
  }

  async function startRecording() {
    setError('');
    setPhase('starting');
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (cause) {
      setPhase('idle');
      setError(microphoneError(cause));
      return;
    }
    stream.current = media;
    const mimeType = chooseAudioMimeType(type => MediaRecorder.isTypeSupported(type));
    const created = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
    recorder.current = created;
    chunks.current = [];
    discard.current = false;
    created.ondataavailable = event => {
      if (event.data.size > 0) chunks.current.push(event.data);
    };
    created.onstop = () => finished(new Blob(chunks.current, { type: created.mimeType || mimeType || 'audio/webm' }));
    created.start();
    setSeconds(0);
    setPhase('recording');
    timer.current = setInterval(() => setSeconds(current => current + 1), 1000);
  }

  // 到上限自动结束并转写：服务端有 10 MiB 上限，长时间录音也没有意义，不如在这里收住。
  useEffect(() => {
    if (phase === 'recording' && seconds >= maxRecordingSeconds) stopRecording();
    // 依赖只写 phase/seconds：stopRecording 只读 ref，每次渲染重建不影响正确性。
  }, [phase, seconds]);

  const recording = phase === 'recording';
  const busy = phase === 'starting' || phase === 'transcribing';
  const mic = <Button
    size="small"
    aria-label={recording ? '结束录音' : '语音输入'}
    icon={recording ? <StopOutlined aria-hidden="true" /> : <AudioOutlined aria-hidden="true" />}
    disabled={reason !== null || busy || phase === 'failed'}
    loading={busy}
    onClick={() => { if (recording) stopRecording(); else void startRecording(); }}
  >{recording ? '结束录音' : '语音输入'}</Button>;
  // 不可用的原因文案很长（含别名与接口路径），放在悬浮提示里，不占按钮行的宽度；
  // 提示挂在一层 span 上：禁用的原生按钮不派发鼠标事件，直接挂在按钮上悬停不出提示（实测）。
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
    {reason === null ? mic : <Tooltip title={reason}><span>{mic}</span></Tooltip>}
    {phase === 'starting' && <span className="composer-hint" role="status">正在打开麦克风…</span>}
    {recording && <span className="composer-hint" role="status">正在录音，点击结束 · {formatRecordingTime(seconds)}/{formatRecordingTime(maxRecordingSeconds)}</span>}
    {recording && <Button size="small" type="text" onClick={() => stopRecording(true)}>取消录音</Button>}
    {phase === 'transcribing' && <span className="composer-hint" role="status">正在转写…</span>}
    {error !== '' && <span className="composer-hint" role="alert" style={{ color: '#cf1322' }}>{error}</span>}
    {phase === 'failed' && <Button size="small" icon={<ReloadOutlined aria-hidden="true" />} onClick={() => { if (recorded.current) void upload(recorded.current); }}>重试转写</Button>}
    {phase === 'failed' && <Button size="small" type="text" icon={<DeleteOutlined aria-hidden="true" />} onClick={() => { recorded.current = null; setError(''); setSeconds(0); setPhase('idle'); }}>丢弃录音</Button>}
  </span>;
}
