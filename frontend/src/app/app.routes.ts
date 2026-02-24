import { Routes } from '@angular/router';
import { LoginPage } from './components/login-page/login-page';
import { authGuard, authGuardAdmin, authGuardSuperAdmin, authGuardUser } from './auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    component: LoginPage,
  },
  {
    path: '',
    loadComponent: () => import('./components/main-page/main-page').then((m) => m.MainPage),
    canActivate: [authGuard],
    children: [
      { path: 'shop', canActivate: [authGuardUser], loadComponent: () => import('./components/shop/shop').then((m) => m.Shop) },
      { path: 'items/list', canActivate: [authGuardAdmin], loadComponent: () => import('./components/items-list/items-list').then((m) => m.ItemsList) },
      { path: 'items/new', canActivate: [authGuardAdmin], loadComponent: () => import('./components/item-create/item-create').then((m) => m.ItemCreate) },
      { path: 'inventory', canActivate: [authGuardAdmin], loadComponent: () => import('./components/inventory/inventory').then((m) => m.Inventory) },
      { path: 'items/:id/edit', canActivate: [authGuardAdmin], loadComponent: () => import('./components/item-edit/item-edit').then((m) => m.ItemEdit) },
      { path: 'items', redirectTo: 'items/list', pathMatch: 'full' },
      { path: 'users', canActivate: [authGuardSuperAdmin], loadComponent: () => import('./components/user-table/user-table').then((m) => m.UserTable) },
      //{ path: 'settings', canActivate: [authGuardSuperAdmin], loadComponent: () => import('./components/settings-window/settings-window').then((m) => m.SettingsWindow) },
      { path: '', loadComponent: () => import('./components/role-home/role-home').then((m) => m.RoleHome), pathMatch: 'full' },
    ],
  },
  {
    path: '**',
    redirectTo: '',
  },
];
