import { useState } from 'react';
import { Outlet } from 'react-router-dom';

import { Navbar } from '../components/Navbar.jsx';
import { Sidebar } from '../components/Sidebar.jsx';

/**
 * The application shell: fixed sidebar, sticky header, scrolling content.
 *
 * The sidebar is a drawer below `lg` and static above it. Only the content
 * column scrolls, which keeps the navigation and the low-stock indicator
 * visible while someone works through a long table.
 */
export function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Navbar onMenuClick={() => setSidebarOpen(true)} />

        <main className="flex-1 p-4 lg:p-6">
          <Outlet />
        </main>

        <footer className="border-t border-border px-4 py-3 text-2xs text-muted-foreground lg:px-6">
          StockPulse — totals are computed by the server in exact decimal arithmetic.
        </footer>
      </div>
    </div>
  );
}