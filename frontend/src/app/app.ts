import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppHeaderComponent } from './components/app-header/app-header';
import { ToastComponent } from './components/toast/toast.component';
import { ThemeService } from './services/theme.service';

@Component({
	selector: 'app-root',
	standalone: true,
	templateUrl: './app.html',
	imports: [RouterOutlet, AppHeaderComponent, ToastComponent],
})
export class App {
	constructor() {
		inject(ThemeService);
	}
}
