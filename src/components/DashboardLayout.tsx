import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

export default function DashboardLayout() {
  return (
    <div className="min-h-screen bg-[#0a0e17] flex relative">
      <div className="fixed inset-0 bg-grid-pattern pointer-events-none" />
      <div className="fixed top-0 left-1/3 w-[600px] h-[600px] bg-emerald-500/[0.03] rounded-full blur-[120px] pointer-events-none" />
      <div className="fixed bottom-0 right-1/4 w-[500px] h-[500px] bg-teal-500/[0.02] rounded-full blur-[100px] pointer-events-none" />
      <Sidebar />
      <main className="flex-1 overflow-y-auto relative">
        <div className="p-4 lg:p-8 lg:pl-8 pt-16 lg:pt-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
