export type WorkspaceView = 'sales'|'dashboard'|'archive'|'ai-content'|'leads'|'sdr'|'roadmap'|'methodology'|'system-docs'|'settings'|'interface-review';
export const workspaceViews:WorkspaceView[]=['sales','dashboard','archive','ai-content','leads','sdr','roadmap','methodology','system-docs','settings','interface-review'];
export function readWorkspaceView(hash:string):WorkspaceView {
  if(/^#project-.+/.test(hash))return 'dashboard';
  const route=hash.replace(/^#\/?/,'').split('?')[0];
  if(route==='overview')return 'sdr';
  if(route==='documents')return 'dashboard';
  return workspaceViews.includes(route as WorkspaceView)?route as WorkspaceView:'sdr';
}
