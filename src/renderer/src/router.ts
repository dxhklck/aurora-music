import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'discover', component: () => import('./views/DiscoverView.vue') },
    { path: '/search', name: 'search', component: () => import('./views/SearchView.vue') },
    { path: '/charts', name: 'charts', component: () => import('./views/ChartsView.vue') },
    {
      path: '/charts/:platform/:id',
      name: 'chart-detail',
      component: () => import('./views/ChartDetailView.vue'),
      props: true
    },
    { path: '/library', name: 'library', component: () => import('./views/LibraryView.vue') },
    { path: '/favorites', name: 'favorites', component: () => import('./views/PlaylistView.vue') },
    {
      path: '/playlist/:id',
      name: 'playlist',
      component: () => import('./views/PlaylistView.vue'),
      props: true
    },
    { path: '/downloads', name: 'downloads', component: () => import('./views/DownloadsView.vue') },
    { path: '/guide', name: 'guide', component: () => import('./views/GuideView.vue') },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') }
  ]
})
