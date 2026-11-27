"""음성 조각 소리 만들기 — MeloTTS 한국어 (v278, 운전자 '걍 MeloTTS로 다 가자'). 저장소 밖 venv 에서 한 번 돌린다.

다시 만들 때 (2026-11-28 에 쓴 방법, 받는 양 약 1.06GB — 다 만든 뒤 폴더째 지웠다):
  1. D:\melotts\ 에 venv (Python 3.11) · PIP_CACHE_DIR · HF_HOME · TMP 를 모두 둔다
  2. pip: torch==2.1.2+cpu torchaudio==2.1.2+cpu (download.pytorch.org/whl/cpu), numpy==1.26.4 transformers==4.27.4
     librosa==0.9.1 soundfile g2pkk jamo==0.4.1 nltk num2words==0.5.12 anyascii==0.3.2 inflect==7.0.0 unidecode==1.3.7
     txtsplit loguru==0.7.2 pyloudnorm python-mecab-ko==1.3.7 (PyPI)
  3. github.com/myshell-ai/MeloTTS 코드 zip → D:\melotts\src\MeloTTS-main (pip 설치 안 함 — setup.py 가 unidic 전체를 받는다)
  4. 모델: huggingface.co/myshell-ai/MeloTTS-Korean (checkpoint.pth·config.json), huggingface.co/kykim/bert-kor-base
     (pytorch_model.bin·vocab.txt·config.json·tokenizer_config.json)
  5. py tools/gen_voice_melo.py <저장소> [--only id,id] [--speed 1.1]  (HF_HUB_OFFLINE=1 로 돌리면 더 받지 않는다)
소리를 다시 만들면 data/voice_clips.json 의 'audio' 판(tools/build_voice_clips.py)을 올린다 — 앱의 Cache Storage 가 새로 받는다.
라이선스: MeloTTS·MeloTTS-Korean MIT, g2pkk Apache-2.0, python-mecab-ko BSD-3, python-mecab-ko-dic Apache-2.0,
kykim/bert-kor-base 표시 없음 (만들 때만 쓰고 배포하지 않음).

MeloTTS(한국어)로 data/voice_clips.json 의 조각을 만든다. D:\\melotts 안에서만 돈다 (venv · 캐시 · 임시 파일).
- 한국어만: 다른 언어 모듈(일본어 MeCab·중국어·영어 등)은 가짜 모듈로 막는다 (전체 unidic 사전 없이)
- g2pkk 의 영어 사전(nltk cmudict, GitHub)은 받지 않는다 — 조각 글에 영어가 없다
- g2pkk 의 형태소 분석기는 Windows 의 eunjeon 대신 python-mecab-ko (PyPI 바퀴)
- 앞뒤 무음을 자르고 소리 크기를 맞춘 뒤(-16 LUFS, 최고 -1 dBFS) 24 kHz 모노 MP3 로 쓴다
  py tools/gen_voice_melo.py <repo> [--only id,id] [--speed 1.1]
"""
import argparse
import json
import os
import sys
import types

ap = argparse.ArgumentParser()
ap.add_argument('repo')
ap.add_argument('--only', default='')
ap.add_argument('--speed', type=float, default=1.1)
ap.add_argument('--wav', default=r'D:\melotts\wav')
a = ap.parse_args()

SRC = r'D:\melotts\src\MeloTTS-main'
sys.path.insert(0, SRC)

# --- 막기: nltk 다운로드 (GitHub) ---
import nltk
import nltk.corpus


def _no_dl(*_a, **_k):
    raise RuntimeError('nltk download blocked')


nltk.download = _no_dl
_find = nltk.data.find
nltk.data.find = lambda res, *x, **k: 'stub' if 'cmudict' in str(res) else _find(res, *x, **k)


class _CMU:
    @staticmethod
    def dict():
        return {}


nltk.corpus.cmudict = _CMU

# --- g2pkk: mecab-ko 경로로 ---
import g2pkk.g2pkk as _gk
_gk.platform = types.SimpleNamespace(system=lambda: 'Linux')

# --- 다른 언어·cached_path 막기 ---
def _stub(name, **attrs):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


def _nope(*_a, **_k):
    raise RuntimeError('language not installed')


for lang in ('chinese', 'japanese', 'english', 'chinese_mix', 'french', 'spanish'):
    _stub('melo.text.' + lang, text_normalize=_nope, g2p=_nope, get_bert_feature=_nope)
for b in ('chinese_bert', 'english_bert', 'spanish_bert', 'french_bert'):
    _stub('melo.text.' + b, get_bert_feature=_nope)
_stub('cached_path', cached_path=_nope)

import numpy as np
import soundfile as sf
import pyloudnorm as pyln
import librosa
from melo.api import TTS

with open(os.path.join(a.repo, 'data', 'voice_clips.json'), encoding='utf-8') as fh:
    clips = json.load(fh)['clips']
if a.only:
    want = set(a.only.split(','))
    clips = [c for c in clips if c['id'] in want]

model = TTS(language='KR', device='cpu')
spk = model.hps.data.spk2id['KR']
SR_IN = model.hps.data.sampling_rate
SR = 24000
meter = pyln.Meter(SR)
out_dir = os.path.join(a.repo, 'audio', 'voice')
os.makedirs(out_dir, exist_ok=True)
os.makedirs(a.wav, exist_ok=True)


def trim(x, sr):
    peak = np.max(np.abs(x)) or 1.0
    thr = peak * 10 ** (-40 / 20)
    idx = np.where(np.abs(x) > thr)[0]
    if not len(idx):
        return x
    pad = int(0.02 * sr)
    return x[max(0, idx[0] - pad): min(len(x), idx[-1] + pad)]


def cap_gaps(x, sr, cap=0.35):
    """조각 안의 긴 쉼(두 문장 조각의 문장 사이 0.8초)을 cap 초로 줄인다"""
    hop = 480
    n = len(x) // hop
    db = 20 * np.log10(np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(1)) + 1e-9)
    keep = np.ones(len(x), bool)
    run = start = 0
    maxf = int(cap * sr / hop)
    for k, v in enumerate(list(db) + [0]):
        if k < n and v < -45:
            if run == 0:
                start = k
            run += 1
        else:
            if run > maxf and start > 0 and k < n:
                keep[(start + maxf) * hop:(start + run) * hop] = False
            run = 0
    return x[keep]


def loud(x):
    y = x if len(x) >= int(0.5 * SR) else np.tile(x, int(np.ceil(0.5 * SR / max(1, len(x)))) + 1)
    lufs = meter.integrated_loudness(y)
    if np.isfinite(lufs):
        x = x * 10 ** ((-16.0 - lufs) / 20)
    peak = np.max(np.abs(x))
    if peak > 0.89:
        x = x * (0.89 / peak)
    return x


info = []
for k, c in enumerate(clips):
    audio = model.tts_to_file(c.get('say') or c['text'], spk, None, speed=a.speed, quiet=True)
    x = librosa.resample(np.asarray(audio, dtype=np.float32), orig_sr=SR_IN, target_sr=SR)
    x = loud(cap_gaps(trim(x, SR), SR)).astype(np.float32)
    sf.write(os.path.join(a.wav, c['id'] + '.wav'), x, SR, subtype='PCM_16')
    sf.write(os.path.join(out_dir, c['id'] + '.mp3'), x, SR, format='MP3')
    info.append({'id': c['id'], 'sec': round(len(x) / SR, 3), 'kb': round(os.path.getsize(os.path.join(out_dir, c['id'] + '.mp3')) / 1024, 1)})
    print('[%d/%d] %s %.2fs %s' % (k + 1, len(clips), c['id'], len(x) / SR, c['text']), flush=True)
with open(os.path.join(a.wav, 'info.json'), 'w', encoding='utf-8') as fh:
    json.dump(info, fh, ensure_ascii=False, indent=0)
print('done', len(info), 'clips', round(sum(i['sec'] for i in info), 1), 's', round(sum(i['kb'] for i in info) / 1024, 2), 'MB')
