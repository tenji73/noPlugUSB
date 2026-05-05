import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
	let httpMock: HttpTestingController;

	const emptyState = {
		systemState: {
			activeDriveId: null as string | null,
			lastConnectedAt: null as string | null,
			isPrinterIdle: true,
		},
		drives: [] as unknown[],
	};

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [App],
			providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter(routes)],
		}).compileComponents();
		httpMock = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		httpMock.verify();
	});

	it('should create the app', () => {
		const fixture = TestBed.createComponent(App);
		fixture.detectChanges();
		httpMock.expectOne('/api/state').flush(emptyState);
		const app = fixture.componentInstance;
		expect(app).toBeTruthy();
	});

	it('should render title', async () => {
		const fixture = TestBed.createComponent(App);
		fixture.detectChanges();
		httpMock.expectOne('/api/state').flush(emptyState);
		await fixture.whenStable();
		fixture.detectChanges();
		const compiled = fixture.nativeElement as HTMLElement;
		expect(compiled.querySelector('h1')?.textContent).toContain('NoPlugUSB');
	});
});
