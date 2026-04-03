// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { createRoot } from 'react-dom/client'
import { ThemeUIProvider } from 'theme-ui'
import { Provider } from 'react-redux'
import { BrowserRouter as Router, Routes, Route } from 'react-router'
import App from './app'
import store from './store'
import theme from './theme'

const Root = () => (
  <ThemeUIProvider theme={theme}>
    <Provider store={store}>
      <Router
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true
        }}>
        <Routes>
          <Route path="/*" element={<App />} />
        </Routes>
      </Router>
    </Provider>
  </ThemeUIProvider>
)

const root = createRoot(document.getElementById('root'))
root.render(<Root />)
