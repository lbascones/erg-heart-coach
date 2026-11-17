/**
 * Video mode: a YouTube playlist (music videos, scenery…) in shuffled order, played with sound.
 * Uses the YouTube IFrame Player API, loaded only when video mode is first switched on.
 */

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

/** Playlist IDs from what the user pasted: full links (…?list=PL…) or bare IDs, one per line. */
export function playlistIds(text: string): string[] {
  const ids: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /[?&]list=([\w-]+)/.exec(line);
    const id = m ? m[1] : /^[\w-]{10,}$/.test(line) ? line : null;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

let apiReady: Promise<void> | null = null;
function loadApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  apiReady ??= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      apiReady = null;
      reject(new Error('YouTube could not be reached'));
    };
    document.head.appendChild(s);
  });
  return apiReady;
}

const PLAYING = 1;
const CUED = 5;

export class VideoPlayer {
  private player: any = null;
  private list = '';
  private shuffled = false;
  private started = false;
  private wantPlaying = false;
  private ducked = false;

  constructor(
    private host: HTMLElement,
    private say: (message: string) => void,
  ) {}

  /** Creates the player for one of the playlists, picked at random. Does nothing if it already plays one of them. */
  async prepare(playlistText: string) {
    const ids = playlistIds(playlistText);
    if (!ids.length) {
      this.say('Add a YouTube playlist link in Settings → Videos.');
      return;
    }
    if (this.player && ids.includes(this.list)) return;
    this.list = ids[Math.floor(Math.random() * ids.length)];
    this.say('Loading videos…');
    try {
      await loadApi();
    } catch (err) {
      this.say(`${(err as Error).message}. Check the internet connection.`);
      return;
    }
    this.destroy();
    const target = document.createElement('div');
    this.host.replaceChildren(target);
    this.shuffled = this.started = false;
    this.player = new window.YT.Player(target, {
      width: '100%',
      height: '100%',
      playerVars: { listType: 'playlist', list: this.list, rel: 0, playsinline: 1, modestbranding: 1 },
      events: {
        onReady: () => {
          this.say('');
          this.shuffle();
          if (this.wantPlaying) this.play();
        },
        onStateChange: (e: any) => {
          if (e.data === CUED || e.data === PLAYING) this.shuffle();
        },
        // Video removed, private or not allowed outside YouTube: skip it.
        onError: (e: any) => {
          console.info('video error', e?.data, 'skipping');
          this.skipSoon();
        },
      },
    });
  }

  private skipTimer = 0;
  private skipSoon() {
    clearTimeout(this.skipTimer);
    this.skipTimer = window.setTimeout(() => this.player?.nextVideo?.(), 800);
  }

  /** Shuffle once the playlist is known, so every session starts somewhere new. */
  private shuffle() {
    if (this.shuffled || !this.player?.getPlaylist?.()?.length) return;
    this.shuffled = true;
    this.player.setShuffle(true);
    this.player.setLoop(true);
  }

  play() {
    this.wantPlaying = true;
    if (!this.player?.playVideo) return;
    this.shuffle();
    if (!this.started && this.shuffled) {
      this.started = true;
      this.player.playVideoAt(0); // first video of the shuffled order
    } else {
      this.started = true;
      this.player.playVideo();
    }
  }

  /** Skip to the next video (or start playing, if nothing has played yet). */
  next() {
    if (!this.player?.nextVideo) return;
    if (!this.started) this.play();
    else this.player.nextVideo();
  }

  pause() {
    this.wantPlaying = false;
    this.player?.pauseVideo?.();
  }

  /** Turn the video down while an alarm is sounding, so the alarm is heard. */
  duck(on: boolean) {
    if (on === this.ducked || !this.player?.setVolume) return;
    this.ducked = on;
    this.player.setVolume(on ? 15 : 100);
  }

  destroy() {
    this.player?.destroy?.();
    this.player = null;
  }
}
