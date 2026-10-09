import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { UI_LANGUAGE_STORAGE_KEY } from './utils/uiLanguage';

const mode = vi.hoisted(() => ({ manual: true, native: true }));
const businessPage = vi.hoisted(() => vi.fn(() => { throw new Error('Unopened business page mounted'); }));
const get = vi.hoisted(() => vi.fn().mockResolvedValue({ data: {} }));
vi.mock('./utils/workbench', () => ({
  get MANUAL_WORKBENCH() { return mode.manual; },
  get NATIVE_RESEARCH() { return mode.native; },
  RESEARCH_ROUTES: new Set(['/', '/portfolio', '/backtest', '/settings']),
}));
vi.mock('./api', () => ({ default: { get } }));
vi.mock('./contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ authEnabled: true, loggedIn: true, isLoading: false, logout: vi.fn() }),
}));
vi.mock('./stores/agentChatStore', () => ({
  useAgentChatStore: Object.assign((selector: (state: { completionBadge: boolean }) => unknown) => selector({ completionBadge: true }),
    { getState: () => ({ setCurrentRoute: vi.fn() }) }),
}));
vi.mock('./pages/HomePage', () => ({ default: () => <div data-testid="home-page" /> }));
vi.mock('./pages/PortfolioPage', () => ({ default: () => <div data-testid="portfolio-page" /> }));
vi.mock('./pages/BacktestPage', () => ({ default: () => <div data-testid="backtest-page" /> }));
vi.mock('./pages/NativeSettingsPage', () => ({ default: () => <div data-testid="native-settings-page" /> }));
vi.mock('./pages/ChatPage', () => ({ default: businessPage }));
vi.mock('./pages/StockScreeningPage', () => ({ default: businessPage }));
vi.mock('./pages/DecisionSignalsPage', () => ({ default: businessPage }));
vi.mock('./pages/AlertsPage', () => ({ default: businessPage }));
vi.mock('./pages/DataCenterPage', () => ({ default: businessPage }));
vi.mock('./pages/TokenUsagePage', () => ({ default: businessPage }));

const links = [
  ['首页', '/'], ['问股', '/chat'], ['选股', '/screening'], ['持仓', '/portfolio'],
  ['AI 建议', '/decision-signals'], ['回测', '/backtest'], ['告警', '/alerts'],
  ['数据中心', '/data'], ['用量', '/usage'], ['设置', '/settings'],
];
const unopened = ['问股', '选股', 'AI 建议', '告警', '数据中心', '用量'];

beforeEach(() => {
  vi.clearAllMocks();
  mode.manual = true;
  mode.native = true;
  localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'zh');
  window.history.pushState({}, '', '/');
});

describe('Research App navigation', () => {
  it('keeps all ten native links clickable while unopened routes mount only the explanation and no business API', async () => {
    render(<App />);
    await screen.findByTestId('home-page');
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(within(nav).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(links.map(([, path]) => path));
    expect(within(nav).getAllByText('未开放')).toHaveLength(6);
    for (const label of unopened) {
      const link = within(nav).getByRole('link', { name: label });
      expect(link).not.toHaveAttribute('aria-disabled');
      fireEvent.click(link);
      await screen.findByRole('heading', { name: '此功能在私人研究模式下未开放' });
      expect(window.location.pathname).toBe(links.find(([name]) => name === label)?.[1]);
      expect(link).toHaveAttribute('aria-current', 'page');
    }
    expect(businessPage).not.toHaveBeenCalled();
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/api/v1/workbench/status']);
    expect(screen.queryByTestId('chat-completion-badge')).not.toBeInTheDocument();
    for (const [label, testId] of [['持仓', 'portfolio-page'], ['回测', 'backtest-page'], ['设置', 'native-settings-page'], ['首页', 'home-page']]) {
      fireEvent.click(within(nav).getByRole('link', { name: label }));
      await screen.findByTestId(testId);
    }
  });

  it('keeps manual mode unopened menus visible and guarded', async () => {
    mode.native = false;
    render(<App />);
    await screen.findByTestId('home-page');
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(within(nav).getAllByRole('link')).toHaveLength(10);
    expect(within(nav).getAllByText('未开放')).toHaveLength(9);
    for (const [label] of links.slice(1)) {
      fireEvent.click(within(nav).getByRole('link', { name: label }));
      await screen.findByRole('heading', { name: '此功能在私人研究模式下未开放' });
    }
    expect(businessPage).not.toHaveBeenCalled();
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/api/v1/workbench/status']);
  });

  it('uses English badges without changing the original accessible link label', async () => {
    localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en');
    render(<App />);
    await screen.findByTestId('home-page');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getAllByRole('link')).toHaveLength(10);
    expect(within(nav).getAllByText('Not enabled')).toHaveLength(6);
    expect(within(nav).getByRole('link', { name: 'Ask' })).toHaveAttribute('title', 'Ask · Not enabled');
  });
});
