import { NavLink, Outlet, Route, Routes } from 'react-router-dom';
import { PackProvider } from './context/PackContext';
import Home from './pages/Home';
import TeamBuilder from './pages/TeamBuilder';
import PokemonBrowser from './pages/PokemonBrowser';
import MatchupGraph from './pages/MatchupGraph';
import Games from './pages/Games';
import BattleLive from './pages/BattleLive';
import Scenarios from './pages/Scenarios';

const NAV = [
  { to: '/', label: 'Home' },
  { to: '/games', label: 'Games' },
  { to: '/scenarios', label: 'Scenarios' },
  { to: '/teams', label: 'Team Builder' },
  { to: '/browser', label: 'Pokémon Browser' },
  { to: '/graph', label: 'Matchup Graph' },
];

export default function App() {
  return (
    <PackProvider>
      <Routes>
        <Route path="/games/live" element={<BattleLive />} />
        <Route element={<AppShell />}>
          <Route path="/" element={<Home />} />
          <Route path="/games" element={<Games />} />
          <Route path="/teams" element={<TeamBuilder />} />
          <Route path="/browser" element={<PokemonBrowser />} />
          <Route path="/graph" element={<MatchupGraph />} />
        </Route>
      </Routes>
    </PackProvider>
  );
}

function AppShell() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <h2>PokeRedus</h2>
          <small>web ui</small>
        </div>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
