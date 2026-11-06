import React from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  LayoutDashboard,
  ArrowLeftRight,
  ShieldCheck,
  BookOpen,
  LogOut,
  BookMarked,
} from 'lucide-react';

export default function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const navItems = [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ['admin', 'account_holder', 'auditor'] },
    { to: '/transfer', label: 'Transfer', icon: ArrowLeftRight, roles: ['admin', 'account_holder'] },
    { to: '/admin', label: 'Admin', icon: ShieldCheck, roles: ['admin'] },
    { to: '/auditor', label: 'Audit Ledger', icon: BookOpen, roles: ['admin', 'auditor'] },
  ];

  const visibleItems = navItems.filter((item) => user && item.roles.includes(user.role));

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <BookMarked className="w-6 h-6 text-blue-600" />
            <span className="text-xl font-bold text-gray-900">LedgerLine</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">Money movement you can prove</p>
        </div>

        <nav className="flex-1 p-4 space-y-1" aria-label="Main navigation">
          {visibleItems.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              aria-current={location.pathname === to ? 'page' : undefined}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                location.pathname === to
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-200">
          <div className="mb-3 px-3">
            <p className="text-sm font-medium text-gray-900">{user?.name}</p>
            <p className="text-xs text-gray-500">{user?.email}</p>
            <span className="mt-1 inline-block text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full capitalize">
              {user?.role?.replace('_', ' ')}
            </span>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
