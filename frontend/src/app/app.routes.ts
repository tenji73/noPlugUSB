import { Routes } from '@angular/router';

export const routes: Routes = [
	{
		path: '',
		loadComponent: () => import('./pages/dashboard.component').then((m) => m.DashboardComponent),
	},
	{
		path: 'files/:driveId',
		loadComponent: () => import('./pages/file-manager/file-manager.component').then((m) => m.FileManagerComponent),
	},
	{ path: '**', redirectTo: '' },
];
