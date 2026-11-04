import type { Channel, ChannelGroupId } from '../types';
import { groupDisplayLabel } from '../utils/channel';
import { PlaylistService } from '../services/playlist-service';
import type { RecentlyWatchedItem } from '../services/recently-watched';
import { t } from '../i18n';
import { CONFIG } from '../config';

// The Live browse page: one horizontal rail per Favorites, Recently Watched,
// and channel group, as the catalog sections draw theirs. A rail shows its
// first channels; a trailing tile opens the full channel list on its group.

export type LiveRailKind = 'favorites' | 'recent' | 'group';

export interface LiveRail {
  key: string;
  kind: LiveRailKind;
  group: ChannelGroupId;
  title: string;
}

export type LiveRailItems =
  | { kind: 'channels'; channels: Channel[]; total: number }
  | { kind: 'recent'; items: RecentlyWatchedItem[]; total: number };

export function buildLiveRails(playlist: string, recent: RecentlyWatchedItem[]): LiveRail[] {
  const scope = playlist || undefined;
  const rails: LiveRail[] = [];
  if (PlaylistService.getGroupCount('builtin:favorites', scope) > 0) {
    rails.push({ key: 'fav', kind: 'favorites', group: 'builtin:favorites', title: t('channel.favorites') });
  }
  if (recent.length) {
    rails.push({
      key: 'recent',
      kind: 'recent',
      group: 'builtin:recently-watched',
      title: t('channel.recentlyWatched'),
    });
  }
  PlaylistService.getGroupsForPlaylist(scope).forEach((name) => {
    const group = `source:${name}` as ChannelGroupId;
    if (PlaylistService.getGroupCount(group, scope) === 0) return;
    rails.push({ key: `g:${name}`, kind: 'group', group, title: groupDisplayLabel(name) });
  });
  return rails;
}

export function liveRailItems(
  rail: LiveRail,
  playlist: string,
  recent: RecentlyWatchedItem[],
): LiveRailItems {
  const limit = CONFIG.LIVE_RAIL_ITEMS;
  if (rail.kind === 'recent') {
    return { kind: 'recent', items: recent.slice(0, limit), total: recent.length };
  }
  const channels = PlaylistService.getByGroup(rail.group, playlist || undefined);
  return { kind: 'channels', channels: channels.slice(0, limit), total: channels.length };
}

// Keys embed group names, which may hold any character, so they are JSON.
export function liveCardKey(railKey: string, itemKey: string): string {
  return JSON.stringify(['b', railKey, itemKey]);
}

export function parseLiveCardKey(key: string | null): { rail: string; item: string } | null {
  if (!key || key.charAt(0) !== '[') return null;
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== 'b') return null;
    const [, rail, item] = parsed as [string, unknown, unknown];
    return typeof rail === 'string' && typeof item === 'string' ? { rail, item } : null;
  } catch {
    return null;
  }
}
