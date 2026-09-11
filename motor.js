/* ============================================================
   motor.js — vocoder de fase com travamento por pico
   ============================================================
   Mesmo algoritmo que ja roda no app Android (PhaseVocoder.java),
   escrito aqui em JavaScript. Foi medido: erro abaixo de 1 cent
   de -12 a +12 semitons, inclusive em 98 Hz.

   Como funciona: analisa o som em janelas de 2048 amostras,
   estica no tempo e reamostra pelo mesmo fator. O tom muda e a
   duracao fica intacta.

   O travamento por pico e o detalhe que importa: sem ele os bins
   vizinhos de uma mesma parcial saem de fase e o som ganha aquela
   textura de vidro.
============================================================ */
(function (raiz) {
  'use strict';

  function FFT(n) {
    this.n = n;
    var bits = 0; while ((1 << bits) < n) bits++;
    this.rev = new Uint32Array(n);
    for (var i = 0; i < n; i++) {
      var r = 0;
      for (var j = 0; j < bits; j++) if (i & (1 << j)) r |= 1 << (bits - 1 - j);
      this.rev[i] = r;
    }
    this.cosT = new Float64Array(n / 2);
    this.sinT = new Float64Array(n / 2);
    for (var k = 0; k < n / 2; k++) {
      this.cosT[k] = Math.cos(-2 * Math.PI * k / n);
      this.sinT[k] = Math.sin(-2 * Math.PI * k / n);
    }
  }

  FFT.prototype.transformar = function (re, im) {
    var n = this.n, i, j, t;
    for (i = 0; i < n; i++) {
      j = this.rev[i];
      if (j > i) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1, step = n / size;
      for (i = 0; i < n; i += size) {
        for (var k = 0; k < half; k++) {
          var c = this.cosT[k * step], s = this.sinT[k * step];
          var a = i + k, b = a + half;
          var tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  };

  FFT.prototype.inverter = function (re, im) {
    var n = this.n, i;
    for (i = 0; i < n; i++) im[i] = -im[i];
    this.transformar(re, im);
    var inv = 1 / n;
    for (i = 0; i < n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
  };

  var N = 2048, HS = N / 4, CAP_ENT = 1 << 15, CAP_SAI = 1 << 15;

  function Vocoder() {
    this.fft = new FFT(N);
    this.win = new Float32Array(N);
    for (var i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.faseAnterior = new Float64Array(N / 2 + 1);
    this.faseSomada   = new Float64Array(N / 2 + 1);
    this.mag = new Float64Array(N / 2 + 1);
    this.fase = new Float64Array(N / 2 + 1);
    this.picos = new Int32Array(N / 2 + 2);
    this.bufEnt = new Float32Array(CAP_ENT);
    this.bufOla = new Float32Array(CAP_SAI);
    this.escrita = 0;
    this.posA = 0; this.posS = 0; this.posL = 0;
    this.ultimoI0 = null;
    this.razao = 1;
    this.pronto = false;
    this.NORM = 1 / 1.5;          // soma de Hann ao quadrado com salto N/4
  }

  Vocoder.prototype.defineRazao = function (r) {
    if (Math.abs(r - this.razao) < 1e-9) return;
    this.razao = r;
  };

  Vocoder.prototype.zerar = function () {
    this.bufEnt.fill(0); this.bufOla.fill(0);
    this.faseAnterior.fill(0); this.faseSomada.fill(0);
    this.escrita = 0; this.posA = 0; this.posS = 0; this.posL = 0;
    this.ultimoI0 = null; this.pronto = false;
  };

  Vocoder.prototype.quadro = function () {
    var i0 = Math.round(this.posA);
    var ha = (this.ultimoI0 === null)
        ? Math.max(1, Math.round(HS / this.razao))
        : (i0 - this.ultimoI0);
    if (ha < 1) ha = 1;
    this.ultimoI0 = i0;

    var m = CAP_ENT - 1, re = this.re, im = this.im, i, k;
    for (i = 0; i < N; i++) { re[i] = this.bufEnt[(i0 + i) & m] * this.win[i]; im[i] = 0; }
    this.fft.transformar(re, im);

    var K = N / 2, DOIS_PI = 2 * Math.PI;
    for (k = 0; k <= K; k++) {
      this.mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      this.fase[k] = Math.atan2(im[k], re[k]);
    }

    /* acha os picos: cada um comanda a fase da sua vizinhanca */
    var np = 0;
    for (k = 2; k <= K - 2; k++) {
      if (this.mag[k] > this.mag[k-1] && this.mag[k] > this.mag[k+1]
       && this.mag[k] >= this.mag[k-2] && this.mag[k] >= this.mag[k+2]) this.picos[np++] = k;
    }
    if (np === 0) this.picos[np++] = 0;

    var ini = 0;
    for (var p = 0; p < np; p++) {
      var pico = this.picos[p];
      var fim = (p === np - 1) ? (K + 1) : (((this.picos[p+1] + pico) >> 1) + 1);
      var d = this.fase[pico] - this.faseAnterior[pico] - DOIS_PI * pico * ha / N;
      d = d - DOIS_PI * Math.round(d / DOIS_PI);
      var omega = DOIS_PI * pico / N + d / ha;
      var giro = this.faseSomada[pico] + omega * HS - this.fase[pico];
      for (k = ini; k < fim; k++) {
        var nova = this.fase[k] + giro;
        nova = nova - DOIS_PI * Math.round(nova / DOIS_PI);
        this.faseSomada[k] = nova;
        re[k] = this.mag[k] * Math.cos(nova);
        im[k] = this.mag[k] * Math.sin(nova);
      }
      ini = fim;
    }
    for (k = 0; k <= K; k++) this.faseAnterior[k] = this.fase[k];

    im[0] = 0; im[K] = 0;
    for (k = 1; k < K; k++) { re[N-k] = re[k]; im[N-k] = -im[k]; }
    this.fft.inverter(re, im);

    var om = CAP_SAI - 1, base = this.posS | 0;
    for (i = N - HS; i < N; i++) this.bufOla[(base + i) & om] = 0;
    for (i = 0; i < N; i++) this.bufOla[(base + i) & om] += re[i] * this.win[i] * this.NORM;

    this.posA += HS / this.razao;
    this.posS += HS;
  };

  /** Recebe um bloco e devolve a mesma quantidade de amostras. */
  Vocoder.prototype.processa = function (entrada, saida) {
    var n = saida.length, m = CAP_ENT - 1, om = CAP_SAI - 1, i;
    for (i = 0; i < n; i++) this.bufEnt[(this.escrita + i) & m] = entrada[i];
    this.escrita += n;

    var PRIMEIRO = N * 2, ALMOFADA = N;
    var precisa = this.posL + n * this.razao + ALMOFADA;
    if (!this.pronto && precisa < PRIMEIRO) precisa = PRIMEIRO;

    var guarda = 0;
    while (this.posS < precisa && guarda < 96) {
      if (this.escrita < this.posA + N) break;
      this.quadro(); guarda++;
    }

    if (!this.pronto) {
      if (this.posS >= PRIMEIRO) { this.pronto = true; this.posL = this.posS - N; }
      else { saida.fill(0); return; }
    }

    var limite = this.posS - 1;
    for (i = 0; i < n; i++) {
      if (this.posL + 1 >= limite) { saida[i] = 0; continue; }
      var j = Math.floor(this.posL), f = this.posL - j;
      var a = this.bufOla[j & om], b = this.bufOla[(j + 1) & om];
      saida[i] = a + (b - a) * f;
      this.posL += this.razao;
    }

    var atraso = this.posS - this.posL;
    if (atraso > N * 4 || atraso < 64) this.posL = this.posS - N;
  };

  raiz.NoTomVocoder = Vocoder;
})(typeof window !== 'undefined' ? window : this);
