import json, os, pathlib, subprocess, tempfile, urllib.request, urllib.parse
TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
def api(method, payload):
    req = urllib.request.Request('https://api.telegram.org/bot' + TOKEN + '/' + method,
        data=urllib.parse.urlencode(payload).encode())
    try:
        with urllib.request.urlopen(req, timeout=90) as r: result=json.load(r)
    except Exception:
        raise RuntimeError('Telegram request failed (details hidden to protect bot token)') from None
    if not result.get('ok'): raise RuntimeError('Telegram did not accept request')
    return result['result']
def download(file_id, dest):
    f=api('getFile',{'file_id':file_id})
    if f.get('file_size',0)>20*1024*1024: raise ValueError('Telegram download limit is 20 MB per input')
    try:
        with urllib.request.urlopen('https://api.telegram.org/file/bot'+TOKEN+'/'+f['file_path'],timeout=90) as r,open(dest,'wb') as out:
            total=0
            while chunk:=r.read(1024*1024):
                total+=len(chunk)
                if total>20*1024*1024: raise ValueError('Input too large')
                out.write(chunk)
    except Exception:
        raise RuntimeError('Input download failed (details hidden to protect bot token)') from None
def run(args):
    result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180)
    if result.returncode: raise RuntimeError('FFmpeg could not read or render this media')
def render(job,folder):
    images=job['images']; audios=job['audios']
    if not 1<=len(images)<=10 or not 1<=len(audios)<=10: raise ValueError('Use 1-10 images and 1-10 audio files')
    pcm=[]
    for i,file_id in enumerate(audios):
        src=folder/f'audio-{i}.input'; wav=folder/f'audio-{i}.wav'
        download(file_id,src)
        run(['ffmpeg','-v','error','-y','-i',str(src),'-vn','-ac','2','-ar','48000','-c:a','pcm_s16le',str(wav)])
        pcm.append(wav)
    listing=folder/'concat.txt'; listing.write_text(''.join("file '"+str(p)+"'\n" for p in pcm))
    track=folder/'music.wav'
    run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',str(listing),'-c','copy',str(track)])
    duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(track)]))
    if not 0<duration<=600: raise ValueError('Use at most 10 minutes of combined audio')
    videos=[]
    for i,file_id in enumerate(images):
        image=folder/f'image-{i}.input'; dest=folder/f'BibleManna-{i+1:02d}.mp4'
        download(file_id,image)
        run(['ffmpeg','-v','error','-y','-loop','1','-framerate','30','-i',str(image),
          '-stream_loop','-1','-ss',str((i*30)%duration),'-i',str(track),'-map','0:v:0','-map','1:a:0',
          '-vf','scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1',
          '-t','30','-r','30','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p',
          '-g','60','-keyint_min','60','-sc_threshold','0','-c:a','aac','-b:a','128k','-ar','48000','-ac','2',
          '-af','afade=t=out:st=29:d=1','-movflags','+faststart',str(dest)])
        if dest.stat().st_size>49*1024*1024: raise ValueError('Output exceeds Telegram video size limit')
        videos.append(dest)
    return videos
def send_video(chat,video):
    boundary='bm-boundary-6019'; head=(f'--{boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n{chat}\r\n'
      f'--{boundary}\r\nContent-Disposition: form-data; name="supports_streaming"\r\n\r\ntrue\r\n'
      f'--{boundary}\r\nContent-Disposition: form-data; name="video"; filename="{video.name}"\r\nContent-Type: video/mp4\r\n\r\n').encode()
    req=urllib.request.Request('https://api.telegram.org/bot'+TOKEN+'/sendVideo',data=head+video.read_bytes()+f'\r\n--{boundary}--\r\n'.encode(),headers={'Content-Type':'multipart/form-data; boundary='+boundary})
    try:
        with urllib.request.urlopen(req,timeout=180) as r:
            if not json.load(r).get('ok'): raise RuntimeError()
    except Exception: raise RuntimeError('Video delivery failed (details hidden to protect bot token)') from None
if __name__=='__main__':
    if not TOKEN: raise SystemExit('Set TELEGRAM_BOT_TOKEN in repository Actions secrets before testing')
    job=json.loads(os.environ['JOB_JSON']); chat=str(job['chat_id'])
    if not chat.isdigit(): raise SystemExit('Only private Telegram chats supported in this test draft')
    try:
        with tempfile.TemporaryDirectory(prefix='bm-') as tmp:
            for video in render(job,pathlib.Path(tmp)): send_video(chat,video)
    except Exception:
        try: api('sendMessage',{'chat_id':chat,'text':'Music video failed. Check file sizes and formats, then try a new batch. No automatic resend.'})
        except Exception: pass
        raise SystemExit('Video job failed. Private media and bot details are omitted from logs.') from None
