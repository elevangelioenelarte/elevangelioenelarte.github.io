// Sesión en vivo: grabación de audio + transcripción con el reconocimiento de voz del sistema.
export class LiveRecorder {
  constructor({ lang = 'es-ES', onFinal, onInterim, onLevel, onStatus } = {}) {
    this.lang = lang;
    this.onFinal = onFinal || (() => {});
    this.onInterim = onInterim || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onStatus = onStatus || (() => {});
    this.chunks = [];
    this.running = false;
    this.startedAt = 0;
  }

  static supportsSpeech() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  static supportsRecording() { return !!(navigator.mediaDevices && window.MediaRecorder); }

  async start() {
    if (this.running) return;
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(m => MediaRecorder.isTypeSupported(m)) || '';
    this.mime = mime;
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.start(5000);
    this.running = true;
    this.startedAt = Date.now();
    this.setupLevels();
    this.startSpeech();
    this.requestWakeLock();
    this.onStatus('Grabando');
  }

  setupLevels() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AC();
      const src = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      const tick = () => {
        if (!this.running) return;
        this.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        this.onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {}
  }

  startSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { this.onStatus('Grabando (este navegador no transcribe en vivo)'); return; }
    const rec = new SR();
    this.rec = rec;
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let restartTimer = null;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0].transcript;
        if (r.isFinal) { if (t.trim()) this.onFinal(t.trim()); }
        else interim += t;
      }
      this.onInterim(interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.onStatus('Sin permiso de dictado: activa Siri y Dictado en Ajustes del iPad');
        this.speechBlocked = true;
      } else if (e.error === 'no-speech' || e.error === 'aborted' || e.error === 'network') {
        // se reinicia en onend
      }
    };
    rec.onend = () => {
      this.onInterim('');
      if (!this.running || this.speechBlocked) return;
      // Safari corta el reconocimiento cada cierto tiempo: lo reanudamos.
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => { try { rec.start(); } catch {} }, 250);
    };
    try { rec.start(); } catch (e) { this.onStatus('No se pudo iniciar el dictado'); }
  }

  async requestWakeLock() {
    try { if (navigator.wakeLock) this.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
    document.addEventListener('visibilitychange', this._vis = async () => {
      if (document.visibilityState === 'visible' && this.running && navigator.wakeLock) {
        try { this.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
      }
    });
  }

  elapsed() { return this.running ? Date.now() - this.startedAt : 0; }

  async stop() {
    if (!this.running) return null;
    this.running = false;
    cancelAnimationFrame(this.raf);
    try { this.rec && (this.rec.onend = null, this.rec.stop()); } catch {}
    const blob = await new Promise(resolve => {
      const rec = this.recorder;
      rec.onstop = () => resolve(new Blob(this.chunks, { type: this.mime || 'audio/webm' }));
      try { rec.state !== 'inactive' ? rec.stop() : rec.onstop(); } catch { resolve(new Blob(this.chunks, { type: this.mime || 'audio/webm' })); }
    });
    this.stream.getTracks().forEach(t => t.stop());
    try { this.audioCtx && this.audioCtx.close(); } catch {}
    try { this.wakeLock && this.wakeLock.release(); } catch {}
    document.removeEventListener('visibilitychange', this._vis);
    this.onLevel(0);
    this.onStatus('Detenido');
    return blob;
  }
}
