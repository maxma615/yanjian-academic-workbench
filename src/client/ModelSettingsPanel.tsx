import { useEffect, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import type { TranslationSettings } from '../shared/translation';
import * as api from './api';
import './model-settings.css';

export function ModelSettingsPanel({ readOnly }: { readOnly: boolean }) {
  const [settings, setSettings] = useState<TranslationSettings>();
  const [baseUrl, setBaseUrl] = useState(''), [model, setModel] = useState(''), [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const apply = (next: TranslationSettings) => { setSettings(next); setBaseUrl(next.baseUrl); setModel(next.model); setApiKey(''); };
  useEffect(() => {
    let current = true;
    void api.translationSettings().then(next => { if (current) apply(next); }).catch(() => { if (current) setError('模型设置未能载入，请重新打开资料与设置。'); });
    return () => { current = false; };
  }, []);
  const dirty = !!settings && (baseUrl.trim() !== settings.baseUrl || model.trim() !== settings.model || !!apiKey.trim());
  const save = async (clearApiKey = false) => {
    if (readOnly || busy || !settings) return;
    setBusy('save'); setError(''); setNotice('');
    try {
      // This panel owns connection fields, not the reader's translation rules.
      const latest = await api.translationSettings();
      const next = await api.saveTranslationSettings({
        baseUrl: clearApiKey ? latest.baseUrl : baseUrl.trim(), model: clearApiKey ? latest.model : model.trim(),
        glossary: latest.glossary, instructions: latest.instructions,
        ...(clearApiKey ? { clearApiKey: true } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      apply(next); setNotice(clearApiKey ? '密钥已清除。文献和已保存译文仍可在本地阅读。' : '模型设置已保存，文献识别与全文翻译共用此配置。');
    } catch (caught) { setError(caught instanceof Error ? caught.message : '模型设置未保存，请重试。'); }
    finally { setBusy(''); }
  };
  const test = async () => {
    if (readOnly || busy || dirty) return;
    setBusy('test'); setError(''); setNotice('');
    try { await api.testTranslationConnection(); setNotice('连接测试通过，可以识别文献信息和翻译。'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '连接未完成，请检查模型设置。'); }
    finally { setBusy(''); }
  };
  return <section className="card settings-card model-settings" aria-labelledby="model-settings-title">
    <div className="model-settings-heading"><div><h2 id="model-settings-title">在线模型</h2><p>配置一次，用于导入文献时识别信息，以及阅读时的全文翻译。</p></div><span className={`model-key-state${settings?.hasApiKey ? ' configured' : ''}`}>{settings ? settings.hasApiKey ? '密钥已配置' : '尚未配置密钥' : '正在读取…'}</span></div>
    {error && <p className="model-settings-feedback error" role="alert">{error}</p>}
    {settings?.keyError && <p className="model-settings-feedback error" role="alert">{settings.keyError}</p>}
    {settings && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="model-connection-fields">
        <label className="field"><span>Base URL（API 地址）</span><input aria-label="Base URL（API 地址）" type="url" value={baseUrl} required disabled={readOnly || !!busy} onChange={event => { setBaseUrl(event.target.value); setApiKey(''); }} spellCheck={false} autoComplete="off" placeholder="https://api.deepseek.com" /></label>
        <label className="field"><span>模型名称</span><input aria-label="模型名称" value={model} required maxLength={128} disabled={readOnly || !!busy} onChange={event => setModel(event.target.value)} spellCheck={false} autoComplete="off" /></label>
        <label className="field model-key-field"><span>API Key（密钥）</span><input aria-label="API Key（密钥）" type="password" value={apiKey} disabled={readOnly || !!busy} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" spellCheck={false} placeholder={settings.hasApiKey && baseUrl.trim() === settings.baseUrl ? '已配置；留空保留现有密钥' : '填写模型服务提供的 API Key'} /></label>
      </div>
      <p className="model-settings-help">支持 DeepSeek 等 OpenAI 兼容接口。填写服务根地址，不需要添加 /chat/completions。<button type="button" className="model-preset" disabled={readOnly || !!busy} onClick={() => { setBaseUrl('https://api.deepseek.com'); setModel('deepseek-flash'); setApiKey(''); }}>使用 DeepSeek 默认值</button></p>
      <p className="model-settings-help">{settings.keyStorage === 'encrypted' ? '密钥由本机系统加密保存，不回显。' : '浏览器预览的密钥仅保留在服务进程内，服务重启后需重新填写。'} 更换 API 地址需重新填写密钥。密钥不进入文献资料、备份或 GitHub 同步。</p>
      <div className="model-data-scope"><p><strong>导入文献：</strong>将 PDF 首页文字及嵌入元数据发给模型，生成标题、作者、年份等候选，核对后保存。</p><p><strong>全文翻译：</strong>开始翻译后，按段发送论文文字；原 PDF、文献信息与译文保存在本机。</p></div>
      <div className="model-settings-actions"><button type="submit" className="button primary" disabled={readOnly || !!busy}><Check size={15} />{busy === 'save' ? '正在保存…' : '保存模型设置'}</button><button type="button" className="button secondary" disabled={readOnly || !!busy || dirty || !settings.hasApiKey || !!settings.keyError} onClick={() => void test()}><RefreshCw size={15} className={busy === 'test' ? 'spin' : ''} />测试连接</button>{(settings.hasApiKey || settings.keyError) && <button type="button" className="button ghost" disabled={readOnly || !!busy} onClick={() => void save(true)}>清除密钥</button>}</div>
      <p className="model-settings-help">测试连接仅向已保存地址 <span className="model-endpoint">{settings.baseUrl}</span> 发送短测试句，不发送论文，服务方可能计费。{dirty && '请先保存修改，再测试连接。'}</p>
      {notice && <p className="model-settings-feedback" role="status">{notice}</p>}
    </form>}
  </section>;
}
