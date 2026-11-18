#!/usr/bin/env python3
"""BibleManna video renderer - Telegram file-ID variant for GitHub Actions.

Same render semantics as render_local.py (= the user's Windows BibleVideoBot
script): one MP3 per image in sequential rotation, each from its beginning,
30s cap, short audio plays once then silence (flagged, never looped).
Inputs arrive as Telegram file IDs in JOB_JSON; the bot token comes only
from the TELEGRAM_BOT_TOKEN env (repository secret), never from the payload.

JOB_JSON: {"chat_id": "123...", "images": ["file_id",...], "audios": ["file_id",...]}
Outputs: post/<name>.mp4 (original size) and story/<name>.mp4 (1080x1920,
corner-detected pad) sent back to the private chat as videos, then a summary
message. 1-10 images and 1-10 audios per batch, 20 MB Telegram download cap
per input (bot API limit).
"""
import json, os, pathlib, subprocess, sys, tempfile, urllib.request, urllib.parse

TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
# Owner-only allowlist: comma-separated Telegram chat IDs, set as a repository
# variable (ALLOWED_CHAT_IDS). A job for any other chat is refused before any
# download or render, so a misfired dispatch can never spend Actions minutes
# or message a stranger. Never logged beyond the refusal count.
ALLOWED = {c.strip() for c in os.environ.get('ALLOWED_CHAT_IDS', '').split(',') if c.strip()}
VIDEO_DURATION = 30
FPS = 30

def api(method, payload):
    req = urllib.request.Request('https://api.telegram.org/bot' + TOKEN + '/' + method,
        data=urllib.parse.urlencode(payload).encode())
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            result = json.load(r)
    except Exception:
        raise RuntimeError('Telegram request failed') from None
    if not result.get('ok'):
        raise RuntimeError('Telegram did not accept request')
    return result['result']

def download(file_id, dest):
    f = api('getFile', {'file_id': file_id})
    if f.get('file_size', 0) > 20 * 1024 * 1024:
        raise ValueError('Telegram download limit is 20 MB per input')
    try:
        with urllib.request.urlopen('https://api.telegram.org/file/bot' + TOKEN + '/' + f['file_path'], timeout=90) as r, open(dest, 'wb') as out:
            total = 0
            while chunk := r.read(1024 * 1024):
                total += len(chunk)
                if total > 20 * 1024 * 1024:
                    raise ValueError('Input too large')
                out.write(chunk)
    except ValueError:
        raise
    except Exception:
        raise RuntimeError('Input download failed') from None

def run(args):
    r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
    if r.returncode:
        raise RuntimeError('ffmpeg failed: ' + r.stderr.decode()[-400:])

def ffprobe_duration(path):
    out = subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
        'format=duration', '-of', 'default=nw=1:nk=1', str(path)])
    return float(out)

def detect_bg_color(image_path):
    from PIL import Image
    img = Image.open(image_path).convert('RGB')
    width, height = img.size
    pixels = [img.getpixel((10, 10)), img.getpixel((width - 10, 10)),
              img.getpixel((10, height - 10)), img.getpixel((width - 10, height - 10))]
    avg = sum(sum(p) / 3 for p in pixels) / len(pixels)
    return 'white' if avg > 180 else 'black'

def send_video(chat, video):
    boundary = 'bm-boundary-6019'
    head = (f'--{boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n{chat}\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="supports_streaming"\r\n\r\ntrue\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="video"; filename="{video.name}"\r\nContent-Type: video/mp4\r\n\r\n').encode()
    req = urllib.request.Request('https://api.telegram.org/bot' + TOKEN + '/sendVideo',
        data=head + video.read_bytes() + f'\r\n--{boundary}--\r\n'.encode(),
        headers={'Content-Type': 'multipart/form-data; boundary=' + boundary})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            if not json.load(r).get('ok'):
                raise RuntimeError()
    except Exception:
        raise RuntimeError('Video delivery failed') from None

def render(job, folder, out):
    images = job['images']; audios = job['audios']
    if not 1 <= len(images) <= 10 or not 1 <= len(audios) <= 10:
        raise ValueError('Use 1-10 images and 1-10 audio files')
    audio_paths = []
    for i, fid in enumerate(audios):
        p = folder / f'audio-{i}.mp3'
        download(fid, p)
        audio_paths.append(p)
    post_dir = out / 'post'; story_dir = out / 'story'
    post_dir.mkdir(parents=True, exist_ok=True); story_dir.mkdir(parents=True, exist_ok=True)
    videos = []
    for i, fid in enumerate(images):
        image = folder / f'image-{i}.input'
        download(fid, image)
        audio = audio_paths[i % len(audio_paths)]
        audio_len = ffprobe_duration(audio)
        short = audio_len < VIDEO_DURATION
        stem = f'BibleManna-{i+1:02d}'
        common_in = ['-loop', '1', '-i', str(image), '-i', str(audio),
                     '-t', str(VIDEO_DURATION), '-r', str(FPS)]
        common_enc = ['-c:v', 'libx264', '-profile:v', 'baseline', '-preset', 'medium',
                      '-pix_fmt', 'yuv420p', '-b:v', '2000k',
                      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
                      '-movflags', '+faststart']
        post = post_dir / f'{stem}.mp4'
        run(['ffmpeg', '-v', 'error', '-y', *common_in, *common_enc, str(post)])
        bg = detect_bg_color(image)
        story = story_dir / f'{stem}.mp4'
        run(['ffmpeg', '-v', 'error', '-y', *common_in,
             '-filter_complex',
             'scale=1080:1920:force_original_aspect_ratio=decrease,'
             f'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:{bg}',
             *common_enc, str(story)])
        for v in (post, story):
            if v.stat().st_size > 49 * 1024 * 1024:
                raise ValueError('Output exceeds Telegram video size limit')
        videos.append((post, story, audio.name if hasattr(audio, 'name') else str(i % len(audio_paths) + 1), short))
    return videos

if __name__ == '__main__':
    if not TOKEN:
        raise SystemExit('Set TELEGRAM_BOT_TOKEN in repository Actions secrets before testing')
    job = json.loads(os.environ['JOB_JSON'])
    chat = str(job['chat_id'])
    if not chat.lstrip('-').isdigit():
        raise SystemExit('Only private Telegram chats supported in this draft')
    if not ALLOWED or chat not in ALLOWED:
        raise SystemExit('Chat not on the owner allowlist; job refused')
    try:
        out = pathlib.Path(os.environ.get('OUT_DIR', 'out-videos'))
        with tempfile.TemporaryDirectory(prefix='bm-') as tmp:
            videos = render(job, pathlib.Path(tmp), out)
            for post, story, audio_name, short in videos:
                send_video(chat, post)
                send_video(chat, story)
            shorts = sum(1 for *_, s in videos if s)
            note = f' ({shorts} audio track(s) shorter than 30s - trailing silence kept)' if shorts else ''
            api('sendMessage', {'chat_id': chat,
                'text': f'BibleManna videos done: {len(videos)} images x2 formats (post + story){note}.'})
    except Exception:
        try:
            api('sendMessage', {'chat_id': chat,
                'text': 'Music video failed. Check file sizes and formats, then try a new batch. No automatic resend.'})
        except Exception:
            pass
        raise SystemExit('Video job failed. Private media and bot details are omitted from logs.') from None
