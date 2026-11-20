import React, { useEffect, useRef, useState } from 'react';
import {
  Blocks,
  FolderKanban,
  Languages,
  PanelLeft,
  Plus,
  Settings,
  UserRound,
} from 'lucide-react';
import type {
  AccountsStateSnapshot,
  AcpConnectionStatus,
  ClientLocale,
  GravityIconId,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { resolveGravityIconVariant } from '../styles/theme';

export interface ActivityRailProps {
  appIcon: GravityIconId;
  sidebarCollapsed: boolean;
  connection: AcpConnectionStatus;
  accounts: AccountsStateSnapshot;
  projectCount: number;
  pluginCount: number;
  activeSessionCount: number;
  hasAvailableUpdate?: boolean;
  availableUpdateVersion?: string;
  onToggleSidebar: () => void;
  onOpenNewSession: () => void;
  onOpenProjects: () => void;
  onOpenPlugins: () => void;
  onOpenAccounts: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  onChangeLocale: (locale: ClientLocale) => void;
}

/**
 * 极窄图标轨（48px）：承载最高频的一级导航（新建、会话抽屉、项目、插件、账户菜单、设置），
 * 即使收起会话抽屉也随时可触达，让主画布保持最大居中视野。
 */
export function ActivityRail({
  appIcon,
  sidebarCollapsed,
  connection,
  accounts,
  projectCount,
  pluginCount,
  activeSessionCount,
  hasAvailableUpdate = false,
  availableUpdateVersion,
  onToggleSidebar,
  onOpenNewSession,
  onOpenProjects,
  onOpenPlugins,
  onOpenAccounts,
  onOpenSettings,
  onOpenAbout,
  onChangeLocale,
}: ActivityRailProps): React.ReactElement {
  const { locale, dict } = useI18n();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (!menuAnchorRef.current?.contains(e.target as Node)) setAccountMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAccountMenuOpen(false);
    };
    window.addEventListener('mousedown', onOutside);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onOutside);
      window.removeEventListener('keydown', onEsc);
    };
  }, [accountMenuOpen]);

  const icon = resolveGravityIconVariant(appIcon);
  const activeProfile =
    accounts.profiles.find((p) => p.profileId === accounts.activeProfileId) ?? accounts.profiles[0];
  const profileName = activeProfile?.name ?? 'Default';
  const initial = profileName.trim().charAt(0).toUpperCase() || 'G';

  return (
    <nav className="activity-rail" aria-label="Gravity" data-testid="activity-rail">
      <div className="rail-top">
        <button
          type="button"
          className="rail-brand-btn"
          onClick={onOpenAbout}
          title={`Gravity · ${connection.connected ? dict.acpConnected : dict.acpDisconnected}`}
          aria-label="Gravity"
        >
          <img
            src={icon.publicSvgUrl}
            alt="Gravity"
            className="brand-logo"
            data-testid="topbar-app-icon"
          />
        </button>

        <button
          type="button"
          className="rail-btn rail-new-btn"
          onClick={onOpenNewSession}
          title={`${dict.newSession} (Ctrl+N)`}
          aria-label={dict.newSession}
          data-testid="sidebar-new-session-btn"
        >
          <Plus size={17} strokeWidth={2.2} />
        </button>
      </div>

      <div className="rail-sep" aria-hidden="true" />

      <div className="rail-nav">
        <button
          type="button"
          className={`rail-btn ${!sidebarCollapsed ? 'is-active' : ''}`}
          onClick={onToggleSidebar}
          aria-pressed={!sidebarCollapsed}
          title={sidebarCollapsed ? dict.sidebarToggleShow : dict.sidebarToggleHide}
          aria-label={sidebarCollapsed ? dict.sidebarToggleShow : dict.sidebarToggleHide}
          data-testid="toggle-left-sidebar-btn"
        >
          <PanelLeft size={17} />
          {activeSessionCount > 0 && sidebarCollapsed && (
            <span className="rail-dot" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          className="rail-btn"
          onClick={onOpenProjects}
          title={dict.ui.projects}
          aria-label={dict.ui.projects}
          data-testid="open-projects-modal-btn"
        >
          <FolderKanban size={17} />
          {projectCount > 0 && <span className="rail-badge">{projectCount}</span>}
        </button>

        <button
          type="button"
          className="rail-btn"
          onClick={onOpenPlugins}
          title={dict.navPlugins}
          aria-label={dict.navPlugins}
          data-testid="open-plugins-modal-btn"
        >
          <Blocks size={17} />
          {pluginCount > 0 && <span className="rail-badge">{pluginCount}</span>}
        </button>
      </div>

      <span className="spacer" />

      <div className="rail-bottom" ref={menuAnchorRef}>
        {accountMenuOpen && (
          <div className="popover rail-account-menu" role="menu" data-testid="account-menu">
            <div className="account-menu-head">
              <span className="avatar avatar-lg">{initial}</span>
              <div className="account-menu-id">
                <strong className="truncate">{profileName}</strong>
                <span className={`account-menu-conn ${connection.connected ? 'is-on' : 'is-off'}`}>
                  <span className={`status-dot ${connection.connected ? 'is-idle' : 'is-error'}`} />
                  {connection.connected ? dict.acpConnected : dict.acpDisconnected}
                  {connection.agyVersion ? ` · ${connection.agyVersion}` : ''}
                </span>
              </div>
            </div>
            <div className="menu-sep" />
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              data-testid="open-accounts-modal-btn"
              onClick={() => {
                setAccountMenuOpen(false);
                onOpenAccounts();
              }}
            >
              <UserRound size={14} className="muted" />
              <span>{dict.navAccounts}</span>
              <span className="menu-item-hint">{accounts.profiles.length || 1}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setAccountMenuOpen(false);
                onOpenSettings();
              }}
            >
              <Settings size={14} className="muted" />
              <span>{dict.navSettings}</span>
              <span className="kbd">Ctrl ,</span>
            </button>
            <div className="menu-sep" />
            <div className="menu-row">
              <Languages size={14} className="muted" />
              <span>{dict.languageLabel}</span>
              <div className="segmented segmented-sm locale-toggle" data-testid="locale-switcher">
                <button
                  type="button"
                  className={`segmented-btn ${locale === 'zh-CN' ? 'is-active' : ''}`}
                  onClick={() => onChangeLocale('zh-CN')}
                  data-testid="locale-switch-zh"
                >
                  中
                </button>
                <button
                  type="button"
                  className={`segmented-btn ${locale === 'en-US' ? 'is-active' : ''}`}
                  onClick={() => onChangeLocale('en-US')}
                  data-testid="locale-switch-en"
                >
                  EN
                </button>
              </div>
            </div>
          </div>
        )}

        <button
          type="button"
          className={`rail-btn rail-avatar-btn ${accountMenuOpen ? 'is-active' : ''}`}
          onClick={() => setAccountMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={accountMenuOpen}
          title={`${profileName} · ${connection.connected ? dict.acpConnected : dict.acpDisconnected}`}
          aria-label={dict.ui.accountMenu}
          data-testid="account-menu-btn"
        >
          <span className="avatar">{initial}</span>
          <span
            className={`rail-conn-dot ${connection.connected ? 'is-idle' : 'is-error'}`}
            aria-hidden="true"
          />
        </button>

        <button
          type="button"
          className="rail-btn"
          onClick={onOpenSettings}
          title={
            hasAvailableUpdate && availableUpdateVersion
              ? `${dict.navSettings} (Ctrl+,) · ${dict.updatesAvailableBadge(availableUpdateVersion)}`
              : `${dict.navSettings} (Ctrl+,)`
          }
          aria-label={dict.navSettings}
          data-testid="open-theme-modal-btn"
        >
          <Settings size={17} />
          {hasAvailableUpdate && (
            <span className="rail-update-dot" aria-hidden="true" data-testid="rail-update-dot" />
          )}
        </button>
      </div>
    </nav>
  );
}
