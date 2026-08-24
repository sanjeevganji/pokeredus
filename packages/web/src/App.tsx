import { NavLink, Route, Routes } from 'react-router-dom';
import { PackProvider } from './context/PackContext';
import Home from './pages/Home';
import TeamBuilder from './pages/TeamBuilder';
import PokemonBrowser from './pages/PokemonBrowser';
import MatchupGraph from './pages/MatchupGraph';
import Games from './pages/Games';

const NAV = [
  { to: '/', label: 'Home' },
  { to: '/games', label: 'Games' },
  { to: '/teams', label: 'Team Builder' },
  { to: '/browser', label: 'Pokémon Browser' },
  { to: '/graph', label: 'Matchup Graph' },
];

export default function App() {
  return (
    <PackProvider>
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
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/games" element={<Games />} />
            <Route path="/teams" element={<TeamBuilder />} />
            <Route path="/browser" element={<PokemonBrowser />} />
            <Route path="/graph" element={<MatchupGraph />} />
          </Routes>
        </main>
      </div>
    </PackProvider>
  );
}
