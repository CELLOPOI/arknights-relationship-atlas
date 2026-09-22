export interface User { id: number; username: string; email: string; isStaff: boolean }
export interface Target { targetType: 'person' | 'relationship'; targetId: string }
export interface FeedbackTarget extends Target { title?: string }
export interface SavedTarget extends Target { id: number; title: string; available: boolean }
export interface Submission extends SavedTarget { body: string; status: 'pending' | 'approved' | 'rejected'; reviewNote: string; createdAt: string }
export interface Person { id: string; name: string; aliases: string[]; factionId: string; factionName: string; isOperator: boolean; avatar: string; avatarSource: string; avatarIsGeneric: boolean; version: number }
export interface Source { kind: string; source: string; line?: number; endLine?: number; version?: string; title?: string; referenceUrl?: string; referenceLabel?: string }
export interface Relation { id: string; title: string; kind: 'mutual' | 'awareness'; from?: string; to?: string; people: Person[]; quote: string; note: string; sources: Source[]; evidence: { id: number; quote: string; sources: Source[] }[] }
export interface Comment { id: number; body: string; author: string; createdAt: string; isOwn: boolean }
export interface Page<T> { results: T[]; count: number; page: number; hasNext: boolean }
declare global {
  interface Window {
    relationshipAtlas?: { getState(): { focus: string | null; nodeCount: number; edgeCount: number }; navigate(id: string): void; showEdge(id: string): void; closePanel(): void };
  }
}

export interface AtlasPerson {
  id: string; name: string; aliases: string[]; factionId: string; factionName: string;
  isOperator?: boolean; avatar?: string; version?: number;
}
export interface AtlasEdge { id: string; source: string; target: string; kind: 'mutual' | 'awareness'; version?: number }
export interface AtlasFaction { id: string; name: string }
export interface AtlasData { nodes: AtlasPerson[]; edges: AtlasEdge[]; factions: AtlasFaction[]; scope?: 'all' | 'operators'; npcCount?: number }
export interface AtlasInstance { ready: Promise<AtlasData | null>; update(data: AtlasData): void; dispose(): void }
