import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendTranscript,
  audioFileExtension,
  chooseAudioMimeType,
  formatRecordingTime,
  microphoneError,
  preferredAudioMimeTypes,
  transcribeAudio,
  voiceUnavailableReason,
} from '@/components/chat/voice-input';

describe('录音格式选择', () => {
  it('按 opus → webm → ogg 顺序取浏览器支持的第一个', () => {
    expect(chooseAudioMimeType(() => true)).toBe('audio/webm;codecs=opus');
    expect(chooseAudioMimeType(type => type === 'audio/webm')).toBe('audio/webm');
    expect(chooseAudioMimeType(type => type === 'audio/ogg')).toBe('audio/ogg');
  });

  it('都不支持时返回 null，交给 MediaRecorder 自己选', () => {
    expect(chooseAudioMimeType(() => false)).toBeNull();
    expect(preferredAudioMimeTypes).toEqual(['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']);
  });

  it('文件扩展名与容器对应，未知类型退回 webm', () => {
    expect(audioFileExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(audioFileExtension('audio/ogg')).toBe('ogg');
    expect(audioFileExtension('audio/mp4')).toBe('m4a');
    expect(audioFileExtension('audio/mpeg')).toBe('mp3');
    expect(audioFileExtension('')).toBe('webm');
  });
});

describe('转写文本追加到输入框', () => {
  it('输入框为空时直接用转写文本', () => {
    expect(appendTranscript('', '写一个登录页')).toBe('写一个登录页');
  });

  it('已有内容用空格分隔', () => {
    expect(appendTranscript('写一个登录页', '再加一个注册页')).toBe('写一个登录页 再加一个注册页');
  });

  it('已有内容以空白结尾时不重复加空格', () => {
    expect(appendTranscript('标题：\n', '正文')).toBe('标题：\n正文');
    expect(appendTranscript('已经结束 ', '继续')).toBe('已经结束 继续');
  });

  it('去掉转写文本首尾空白，空文本不改动输入框', () => {
    expect(appendTranscript('已有内容', '  你好  ')).toBe('已有内容 你好');
    expect(appendTranscript('已有内容', '   ')).toBe('已有内容');
    expect(appendTranscript('', '  ')).toBe('');
  });
});

describe('录音计时', () => {
  it('按 m:ss 显示', () => {
    expect(formatRecordingTime(0)).toBe('0:00');
    expect(formatRecordingTime(7)).toBe('0:07');
    expect(formatRecordingTime(65)).toBe('1:05');
    expect(formatRecordingTime(120)).toBe('2:00');
  });

  it('负数与小数向下取整', () => {
    expect(formatRecordingTime(-3)).toBe('0:00');
    expect(formatRecordingTime(59.9)).toBe('0:59');
  });
});

describe('麦克风错误与禁用原因', () => {
  it('未授权与设备缺失给可操作文案，其它错误带上原始信息', () => {
    expect(microphoneError(new DOMException('denied', 'NotAllowedError'))).toBe('浏览器未授权使用麦克风');
    expect(microphoneError(new DOMException('denied', 'SecurityError'))).toBe('浏览器未授权使用麦克风');
    expect(microphoneError(new DOMException('none', 'NotFoundError'))).toBe('没有找到可用的麦克风');
    expect(microphoneError(new Error('boom'))).toBe('无法访问麦克风：boom');
  });

  it('不可编辑、未配置别名、不支持录音各有说明，可用时为 null', () => {
    expect(voiceUnavailableReason({ editable: false, serverEnabled: true, recorderSupported: true })).toBe('当前不可编辑，无法使用语音输入');
    expect(voiceUnavailableReason({ editable: true, serverEnabled: false, recorderSupported: true })).toContain('未配置语音转写模型');
    expect(voiceUnavailableReason({ editable: true, serverEnabled: true, recorderSupported: false })).toContain('MediaRecorder');
    expect(voiceUnavailableReason({ editable: true, serverEnabled: true, recorderSupported: true })).toBeNull();
  });
});

describe('上传录音转写', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('从 success 包装里取 text，录音放在 audio 字段', async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ code: 0, data: { text: '你好' }, message: 'ok' }));
    vi.stubGlobal('fetch', upstream);
    await expect(transcribeAudio(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }))).resolves.toBe('你好');
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe('/api/app/chat/transcribe');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect(form.get('audio')).toMatchObject({ name: 'recording.webm', type: 'audio/webm' });
  });

  it('服务端文案原样抛出，网络错误不静默失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 40900, data: null, message: '未配置语音转写模型' }, { status: 409 })));
    await expect(transcribeAudio(new Blob(['a'], { type: 'audio/webm' }))).rejects.toThrow('未配置语音转写模型');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(transcribeAudio(new Blob(['a'], { type: 'audio/webm' }))).rejects.toThrow('语音转写失败：网络错误');
  });
});
