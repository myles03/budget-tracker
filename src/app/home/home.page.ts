import { ChangeDetectorRef, Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { 
  IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton, 
  IonIcon, IonSegment, IonSegmentButton, IonInput, IonSelect, IonSelectOption, 
  IonList, IonItem, IonLabel, ToastController 
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  walletOutline, downloadOutline,
  calendarOutline, alertCircleOutline, pieChartOutline, addCircleOutline,
  scanOutline, swapHorizontalOutline,
  trashOutline
} from 'ionicons/icons';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Chart, registerables } from 'chart.js';
import jsQR from 'jsqr';
import { environment } from '../../environments/environment';

Chart.register(...registerables);

@Component({
  selector: 'app-home',
  templateUrl: './home.page.html',
  styleUrls: ['./home.page.scss'],
  standalone: true,
  imports: [
    CommonModule, FormsModule, IonHeader, IonToolbar, IonTitle, IonContent, 
    IonButtons, IonButton, IonIcon, IonSegment, IonSegmentButton, IonInput, 
    IonSelect, IonSelectOption, IonList, IonItem, IonLabel
  ]
})
export class HomePage implements AfterViewInit, OnDestroy, OnInit {
  @ViewChild('expenseChart') expenseChartCanvas!: ElementRef;
  @ViewChild('qrVideo') qrVideoElement!: ElementRef<HTMLVideoElement>;

  private apiBase = environment.apiBaseUrl;
  // Auth state
  currentUser: any = null;
  authToken: string | null = null;
  authMode: 'login' | 'signup' = 'login';
  authEmail = '';
  authPassword = '';
  sessionRestoring = true;
  sessionRestoreError = '';

  // Budget state
  activeBudget: any = null;
  budgetInput: number = 0;
  selectedDuration: number = 15;
  currency = '₱';
  
  durationOptions = [
    { label: 'Weekly (7 Days)', days: 7 },
    { label: 'Bi-Weekly (15 Days)', days: 15 },
    { label: 'Monthly (30 Days)', days: 30 }
  ];

  // Expenses state
  expenses: any[] = [];
  expenseTitle = '';
  expenseAmount: number | null = null;
  expenseCategory = 'Food';

  categories = [
    { name: 'Food', icon: 'fast-food-outline', color: '#f59f00' },
    { name: 'Transpo', icon: 'car-outline', color: '#2b8a3e' },
    { name: 'School', icon: 'book-outline', color: '#1864ab' },
    { name: 'Grocery', icon: 'basket-outline', color: '#862e9c' },
    { name: 'Others', icon: 'ellipsis-horizontal-outline', color: '#495057' }
  ];

  // QR Scanner & Scanned Result State
  qrScannerActive = false;
  scannedQrResult: string | null = null;
  scannedQrType: string | null = null;
  private mediaStream: MediaStream | null = null;
  private qrAnimationFrame: number | null = null;
  private qrCanvas: HTMLCanvasElement | null = null;

  // Reminders & Theme
  darkMode = false;
  institutionTheme = 'navy';
  private browserReminderTimer: number | null = null;

  // Currency Converter
  conversionAmount: number | null = null;
  conversionFrom = 'PHP';
  conversionTo = 'USD';
  conversionResult: number | null = null;
  conversionRateDate: string | null = null;
  conversionError = '';
  currencies = [
    { code: 'PHP', name: 'Philippine Peso' },
    { code: 'USD', name: 'US Dollar' },
    { code: 'EUR', name: 'Euro' },
    { code: 'JPY', name: 'Japanese Yen' },
    { code: 'KRW', name: 'South Korean Won' }
  ];

  reportMonth = new Date().toISOString().slice(0, 7);
  private chartInstance: Chart | null = null;
  private conversionRequestId = 0;

  constructor(
    private toastController: ToastController,
    private changeDetectorRef: ChangeDetectorRef
  ) {
    addIcons({
      walletOutline, downloadOutline,
      calendarOutline, alertCircleOutline, pieChartOutline, addCircleOutline,
      scanOutline, swapHorizontalOutline,
      trashOutline
    });
  }

  ngOnInit() {
    void this.restoreSession();
  }

  ngAfterViewInit() {
    if (this.activeBudget) {
      this.renderChart();
    }
  }

  ngOnDestroy() {
    this.stopQrScanner();
    this.cancelBrowserReminderTimer();
  }

  // --- BACKEND AUTHENTICATION & ROUTING ---
  async restoreSession() {
    const token = localStorage.getItem('sb_token');
    if (!token) {
      this.sessionRestoring = false;
      this.changeDetectorRef.markForCheck();
      return;
    }

    try {
      const res = await fetch(`${this.apiBase}auth.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ action: 'validate' })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        localStorage.removeItem('sb_token');
        this.authToken = null;
        this.currentUser = null;
        this.sessionRestoreError = data.message || 'Your session expired. Please sign in again.';
        return;
      }

      this.authToken = token;
      this.currentUser = data.user;
      this.sessionRestoreError = '';
      await this.loadUserData();
      await this.scheduleAutomaticReminder(undefined, false);
    } catch (error) {
      console.error('Error restoring session', error);
      this.sessionRestoreError = 'Unable to verify your saved session. Check your connection and sign in again.';
    } finally {
      this.sessionRestoring = false;
      this.changeDetectorRef.markForCheck();
    }
  }

  async handleAuth() {
    if (!this.authEmail || !this.authPassword) {
      this.showToast('Please enter both email and password.');
      return;
    }

    const action = this.authMode;
    const browserPermissionRequest =
      action === 'login' && !Capacitor.isNativePlatform()
        ? this.requestBrowserNotificationPermission()
        : undefined;
    try {
      const res = await fetch(`${this.apiBase}auth.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, email: this.authEmail, password: this.authPassword })
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        this.showToast(data.message || 'Authentication failed.');
        return;
      }

      this.sessionRestoreError = '';
      if (action === 'signup') {
        this.showToast('Account created successfully! Please log in.');
        this.authMode = 'login';
        this.authPassword = '';
      } else {
        this.authToken = data.token;
        this.currentUser = data.user;
        localStorage.setItem('sb_token', data.token);
        this.showToast('Logged in successfully!');
        await this.loadUserData();
        await this.scheduleAutomaticReminder(browserPermissionRequest);
      }
    } catch (err) {
      this.showToast('Network error connecting to backend.');
    } finally {
      this.changeDetectorRef.markForCheck();
    }
  }

  async logout() {
    void this.cancelAutomaticReminder();
    if (this.authToken) {
      try {
        await fetch(`${this.apiBase}auth.php`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.authToken}`
          },
          body: JSON.stringify({ action: 'logout' })
        });
      } catch {}
    }
    localStorage.removeItem('sb_token');
    this.authToken = null;
    this.currentUser = null;
    this.activeBudget = null;
    this.expenses = [];
    this.stopQrScanner();
    this.showToast('Logged out.');
    this.changeDetectorRef.markForCheck();
  }

  // --- LOAD USER DATA (Budget & Expenses) ---
  async loadUserData() {
    if (!this.authToken) return;

    try {
      // Load budget
      const bRes = await fetch(`${this.apiBase}budget.php`, {
        headers: { 'Authorization': `Bearer ${this.authToken}` }
      });
      const bData = await bRes.json();
      if (bData.success) {
        this.activeBudget = bData.budget;
      }

      // Load expenses
      const eRes = await fetch(`${this.apiBase}expenses.php`, {
        headers: { 'Authorization': `Bearer ${this.authToken}` }
      });
      const eData = await eRes.json();
      if (eData.success) {
        this.expenses = eData.expenses;
      }

      setTimeout(() => this.renderChart(), 100);
    } catch (err) {
      console.error('Error loading data', err);
    } finally {
      this.changeDetectorRef.markForCheck();
    }
  }

  // --- BUDGET MANAGEMENT ---
  incrementBudget(amount: number) {
    this.budgetInput = (Number(this.budgetInput) || 0) + amount;
  }

  clearBudgetInput() {
    this.budgetInput = 0;
  }

  async saveBudget() {
    if (!this.budgetInput || this.budgetInput <= 0) {
      this.showToast('Please enter a valid budget amount.');
      return;
    }

    const durationObj = this.durationOptions.find(d => d.days === this.selectedDuration);
    const payload = {
      totalBudget: Number(this.budgetInput),
      durationDays: this.selectedDuration,
      durationLabel: durationObj ? durationObj.label : `${this.selectedDuration} Days`,
      startDate: new Date().toISOString()
    };

    try {
      const res = await fetch(`${this.apiBase}budget.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        this.activeBudget = payload;
        this.changeDetectorRef.markForCheck();
        this.showToast('Budget saved successfully!');
        setTimeout(() => this.renderChart(), 100);
      } else {
        this.showToast(data.message || 'Failed to save budget.');
      }
    } catch {
      this.showToast('Network error saving budget.');
    }
  }

  async resetBudget() {
    try {
      const res = await fetch(`${this.apiBase}budget.php`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.authToken}` }
      });
      const data = await res.json();
      if (data.success) {
        this.activeBudget = null;
        this.expenses = [];
        this.budgetInput = 0;
        this.changeDetectorRef.markForCheck();
        this.showToast('Budget and expenses reset.');
        this.renderChart();
      }
    } catch {
      this.showToast('Error resetting budget.');
    }
  }

  // --- COMPUTED DASHBOARD METRICS ---
  get totalSpent(): number {
    return this.expenses.reduce((sum, item) => sum + Number(item.amount), 0);
  }

  get remainingBudget(): number {
    return this.activeBudget ? this.activeBudget.totalBudget - this.totalSpent : 0;
  }

  get spentPercentage(): number {
    if (!this.activeBudget || this.activeBudget.totalBudget <= 0) return 0;
    return Math.min(100, Math.round((this.totalSpent / this.activeBudget.totalBudget) * 100));
  }

  get projectedSpending(): number {
    if (!this.activeBudget) return 0;

    const now = Date.now();
    const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
    const recentSpending = this.expenses.reduce((total, expense) => {
      const expenseDate = new Date(expense.date).getTime();
      return expenseDate >= fourteenDaysAgo && expenseDate <= now
        ? total + Number(expense.amount)
        : total;
    }, 0);

    return this.totalSpent + (recentSpending / 14) * this.daysRemaining;
  }

  get willExceedBudget(): boolean {
    return !!this.activeBudget && this.projectedSpending > Number(this.activeBudget.totalBudget);
  }

  get projectedBudgetOverage(): number {
    return this.activeBudget
      ? Math.max(0, this.projectedSpending - Number(this.activeBudget.totalBudget))
      : 0;
  }

  get daysRemaining(): number {
    if (!this.activeBudget) return 0;
    const start = new Date(this.activeBudget.startDate).getTime();
    const durationMs = this.activeBudget.durationDays * 24 * 60 * 60 * 1000;
    const end = start + durationMs;
    const diff = end - Date.now();
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  get dailySafeSpend(): number {
    const days = Math.max(1, this.daysRemaining);
    return Math.max(0, this.remainingBudget / days);
  }

  get spendingInsight(): string {
    if (this.spentPercentage > 85) {
      return 'High spending rate detected. Prioritize essentials for the rest of this cycle.';
    } else if (this.spentPercentage < 40) {
      return 'Great pacing! Your spending is well within your safe allowance.';
    }
    return 'Your daily spending is steady. Keep tracking your transactions.';
  }

  get weeklyForecast(): number { return this.dailySafeSpend * 7; }
  get weeklyBudgetTarget(): number {
    if (!this.activeBudget) return 0;
    return (this.activeBudget.totalBudget / this.activeBudget.durationDays) * 7;
  }
  get monthlyExpenses(): any[] {
    return this.expenses.filter(e => e.date.startsWith(this.reportMonth));
  }
  get monthlyTotal(): number {
    return this.monthlyExpenses.reduce((sum, item) => sum + Number(item.amount), 0);
  }

  // --- QR CODE SCANNER (Visible Scan Result & Type Recognition) ---
  async startQrScanner() {
    this.qrScannerActive = true;
    this.scannedQrResult = null;
    this.scannedQrType = null;

    if (!navigator.mediaDevices?.getUserMedia) {
      this.qrScannerActive = false;
      this.showToast('Camera scanning requires a secure browser connection.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      if (!this.qrScannerActive) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.mediaStream = stream;
      const video = this.qrVideoElement.nativeElement;
      video.srcObject = stream;
      await video.play();
      this.scanQrFrame();
      this.showToast('QR Scanner active. Point camera at receipt or payment QR.');
    } catch (err) {
      console.error('Camera access error:', err);
      this.stopQrScanner();
      this.showToast('Unable to access camera. Check camera permission and try again.');
    }
  }

  private scanQrFrame() {
    const video = this.qrVideoElement?.nativeElement;
    if (!this.qrScannerActive || !this.mediaStream || !video) return;

    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      if (!this.qrCanvas) {
        this.qrCanvas = document.createElement('canvas');
      }
      this.qrCanvas.width = video.videoWidth;
      this.qrCanvas.height = video.videoHeight;
      const context = this.qrCanvas.getContext('2d', { willReadFrequently: true });
      if (context) {
        context.drawImage(video, 0, 0, this.qrCanvas.width, this.qrCanvas.height);
        const frame = context.getImageData(0, 0, this.qrCanvas.width, this.qrCanvas.height);
        const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
        if (code) {
          this.handleQrCode(code.data);
          return;
        }
      }
    }

    this.qrAnimationFrame = requestAnimationFrame(() => this.scanQrFrame());
  }

  private handleQrCode(value: string) {
    const text = value.trim();
    const detectedAmount = this.extractQrAmount(text);
    this.scannedQrResult = text;
    this.scannedQrType = /^https?:\/\//i.test(text) ? 'Link (not opened)' : 'Text';
    this.expenseTitle = text.slice(0, 150);
    if (detectedAmount !== null) {
      this.expenseAmount = detectedAmount;
    }
    this.stopQrScanner();
    this.changeDetectorRef.markForCheck();
    this.showToast(
      detectedAmount !== null
        ? `QR scanned. Detected amount: ${this.currency}${detectedAmount.toFixed(2)}. Review before adding.`
        : 'QR scanned. Enter the expense amount before adding it.'
    );
  }

  private extractQrAmount(text: string): number | null {
    const validAmount = (value: string): number | null => {
      const amount = Number(value.replace(/,/g, ''));
      return Number.isFinite(amount) && amount > 0 && amount <= 99999999 ? amount : null;
    };

    try {
      const payload = JSON.parse(text);
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        for (const key of ['amount', 'total', 'amt']) {
          const value = payload[key];
          if (typeof value === 'number' || typeof value === 'string') {
            const amount = validAmount(String(value).replace(/^(?:PHP|₱)\s*/i, ''));
            if (amount !== null) return amount;
          }
        }
      }
    } catch {
      // Most QR payloads are not JSON.
    }

    const labelledAmount = text.match(
      /(?:^|[?&\s;,])(?:amount|total|amt)\s*[:=]\s*(?:PHP|₱)?\s*([\d,]+(?:\.\d{1,2})?)(?=$|[\s&;,])/i
    );
    if (labelledAmount) {
      const amount = validAmount(labelledAmount[1]);
      if (amount !== null) return amount;
    }

    const currencyAmount = text.match(/(?:PHP|₱)\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (currencyAmount) {
      const amount = validAmount(currencyAmount[1]);
      if (amount !== null) return amount;
    }

    let offset = 0;
    let transactionCurrency: string | null = null;
    let transactionAmount: string | null = null;
    while (offset + 4 <= text.length) {
      const tag = text.slice(offset, offset + 2);
      const lengthText = text.slice(offset + 2, offset + 4);
      if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) return null;

      const length = Number(lengthText);
      const value = text.slice(offset + 4, offset + 4 + length);
      if (value.length !== length) return null;
      if (tag === '53' && /^\d{3}$/.test(value)) {
        transactionCurrency = value;
      } else if (tag === '54' && /^\d+(?:\.\d+)?$/.test(value)) {
        transactionAmount = value;
      }
      offset += 4 + length;
    }

    return transactionAmount && transactionCurrency === '608'
      ? validAmount(transactionAmount)
      : null;
  }

  stopQrScanner() {
    this.qrScannerActive = false;
    if (this.qrAnimationFrame !== null) {
      cancelAnimationFrame(this.qrAnimationFrame);
      this.qrAnimationFrame = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    const video = this.qrVideoElement?.nativeElement;
    if (video) {
      video.srcObject = null;
    }
  }

  // --- ADD EXPENSE ---
  async addExpense() {
    if (!this.expenseTitle || !this.expenseAmount || Number(this.expenseAmount) <= 0) {
      this.showToast('Please provide a valid title and amount.');
      return;
    }

    const payload = {
      title: this.expenseTitle,
      amount: Number(this.expenseAmount),
      category: this.expenseCategory
    };

    try {
      const res = await fetch(`${this.apiBase}expenses.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.expenses.unshift(data.expense);
        this.expenseTitle = '';
        this.expenseAmount = null;
        this.scannedQrResult = null;
        this.scannedQrType = null;
        this.changeDetectorRef.markForCheck();
        this.showToast('Expense recorded successfully!');
        this.renderChart();
      } else {
        this.showToast(data.message || 'Failed to save expense.');
      }
    } catch (error) {
      console.error('Error saving expense', error);
      this.showToast('Network error saving expense.');
    }
  }

  async deleteExpense(id: string) {
    try {
      const res = await fetch(`${this.apiBase}expenses.php?id=${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.authToken}` }
      });
      const data = await res.json();
      if (data.success) {
        this.expenses = this.expenses.filter(e => e.id !== id);
        this.changeDetectorRef.markForCheck();
        this.showToast('Transaction removed.');
        this.renderChart();
      }
    } catch {
      this.showToast('Error deleting expense.');
    }
  }

  private requestBrowserNotificationPermission(): Promise<NotificationPermission | null> {
    if (typeof Notification === 'undefined') return Promise.resolve(null);
    if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
    try {
      return Notification.requestPermission().catch((error): NotificationPermission => {
        console.error('Browser notification permission request failed', error);
        return 'denied';
      });
    } catch (error) {
      console.error('Browser notification permission request failed', error);
      return Promise.resolve<NotificationPermission>('denied');
    }
  }

  private async scheduleAutomaticReminder(
    browserPermission?: Promise<NotificationPermission | null>,
    requestPermission = true
  ) {
    try {
      if (Capacitor.isNativePlatform()) {
        let permission = await LocalNotifications.checkPermissions();
        if (permission.display !== 'granted' && requestPermission) {
          permission = await LocalNotifications.requestPermissions();
        }
        if (permission.display !== 'granted') {
          if (requestPermission) {
            this.showToast('Enable notifications in your device settings to receive the 8:00 PM reminder.');
          }
          return;
        }

        await LocalNotifications.schedule({
          notifications: [
            {
              title: 'SmartBudget Daily Reminder',
              id: 2002,
              body: 'Time to record your daily expenses and check your remaining balance!',
              schedule: { on: { hour: 20, minute: 0 }, repeats: true }
            }
          ]
        });
        if (requestPermission) {
          this.showToast('Daily reminder set for 8:00 PM. Check your device notification center.');
        }
        return;
      }

      const permission = browserPermission
        ? await browserPermission
        : typeof Notification === 'undefined'
          ? null
          : Notification.permission;
      if (permission !== 'granted') {
        if (requestPermission) {
          this.showToast('Allow browser notifications to receive the 8:00 PM reminder.');
        }
        return;
      }

      this.scheduleBrowserReminder();
      if (requestPermission) {
        this.showToast('Daily reminder set for 8:00 PM while SmartBudget remains open in this browser.');
      }
    } catch (error) {
      console.error('Error scheduling daily reminder', error);
      if (requestPermission) {
        this.showToast('Could not schedule the reminder. Check notification permissions.');
      }
    }
  }

  private scheduleBrowserReminder() {
    this.cancelBrowserReminderTimer();
    const now = new Date();
    const nextReminder = new Date(now);
    nextReminder.setHours(20, 0, 0, 0);
    if (nextReminder <= now) nextReminder.setDate(nextReminder.getDate() + 1);

    this.browserReminderTimer = window.setTimeout(() => {
      this.browserReminderTimer = null;
      if (Notification.permission === 'granted') {
        try {
          new Notification('SmartBudget Daily Reminder', {
            body: 'Time to record your daily expenses and check your remaining balance!'
          });
        } catch (error) {
          console.error('Could not display browser reminder', error);
        }
        this.scheduleBrowserReminder();
      }
    }, nextReminder.getTime() - now.getTime());
  }

  private cancelBrowserReminderTimer() {
    if (this.browserReminderTimer !== null) {
      window.clearTimeout(this.browserReminderTimer);
      this.browserReminderTimer = null;
    }
  }

  private async cancelAutomaticReminder() {
    this.cancelBrowserReminderTimer();
    if (Capacitor.isNativePlatform()) {
      try {
        await LocalNotifications.cancel({ notifications: [{ id: 2002 }] });
      } catch (error) {
        console.error('Error cancelling daily reminder on logout', error);
      }
    }
  }

  // --- EXPORT TO CSV / EXCEL ---
  exportMonthlyCsv() {
    if (this.expenses.length === 0) {
      this.showToast('No expenses available to export.');
      return;
    }

    let csvContent = 'ID,Title,Category,Amount,Date\n';
    this.expenses.forEach(e => {
      csvContent += `${e.id},"${e.title}","${e.category}",${e.amount},"${e.date}"\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `SmartBudget_Report_${this.reportMonth}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    this.showToast('CSV report exported successfully!');
  }

  exportMonthlyExcel() {
    // Excel-compatible tab-separated XML / CSV format export
    if (this.expenses.length === 0) {
      this.showToast('No expenses available to export.');
      return;
    }

    let excelContent = 'ID\tTitle\tCategory\tAmount\tDate\n';
    this.expenses.forEach(e => {
      excelContent += `${e.id}\t${e.title}\t${e.category}\t${e.amount}\t${e.date}\n`;
    });

    const blob = new Blob([excelContent], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `SmartBudget_Report_${this.reportMonth}.xls`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    this.showToast('Excel report exported successfully!');
  }

  exportMonthlyPdf() {
    if (this.monthlyExpenses.length === 0) {
      this.showToast('No expenses available for this month.');
      return;
    }

    const reportWindow = window.open('', '_blank');
    if (!reportWindow) {
      this.showToast('Allow pop-ups to print or save this statement as a PDF.');
      return;
    }

    const rows = this.monthlyExpenses.map(expense => `
      <tr>
        <td>${this.escapeHtml(expense.title)}</td>
        <td>${this.escapeHtml(expense.category)}</td>
        <td>${this.currency}${Number(expense.amount).toFixed(2)}</td>
        <td>${this.escapeHtml(expense.date)}</td>
      </tr>
    `).join('');
    reportWindow.document.write(`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>SmartBudget Statement - ${this.escapeHtml(this.reportMonth)}</title>
          <style>
            body { font: 14px Arial, sans-serif; margin: 32px; color: #172033; }
            h1 { margin-bottom: 4px; }
            p { margin-top: 0; color: #526078; }
            table { width: 100%; border-collapse: collapse; margin-top: 24px; }
            th, td { padding: 10px; border-bottom: 1px solid #d8deea; text-align: left; }
            th { background: #f0f3f8; }
            td:nth-child(3), th:nth-child(3) { text-align: right; }
            @media print { body { margin: 16mm; } }
          </style>
        </head>
        <body>
          <h1>SmartBudget Statement</h1>
          <p>${this.escapeHtml(this.reportMonth)} · ${this.monthlyExpenses.length} transaction(s) · Total ${this.currency}${this.monthlyTotal.toFixed(2)}</p>
          <table>
            <thead><tr><th>Title</th><th>Category</th><th>Amount</th><th>Date</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </body>
      </html>`);
    reportWindow.document.close();
    setTimeout(() => {
      reportWindow.focus();
      reportWindow.print();
    }, 250);
  }

  private escapeHtml(value: unknown): string {
    return String(value).replace(/[&<>"']/g, character => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      };
      return entities[character];
    });
  }

  // --- CURRENCY CONVERTER ---
  async autoConvertCurrency() {
    const requestId = ++this.conversionRequestId;
    const amount = Number(this.conversionAmount);
    this.conversionError = '';
    this.conversionRateDate = null;

    if (!Number.isFinite(amount) || amount <= 0) {
      this.conversionResult = null;
      this.changeDetectorRef.markForCheck();
      return;
    }

    if (this.conversionFrom === this.conversionTo) {
      this.conversionResult = amount;
      this.changeDetectorRef.markForCheck();
      return;
    }

    try {
      const params = new URLSearchParams({
        amount: String(amount),
        base: this.conversionFrom,
        symbols: this.conversionTo
      });
      const res = await fetch(`https://api.frankfurter.dev/v1/latest?${params}`);
      if (!res.ok) {
        throw new Error(`Exchange-rate service returned HTTP ${res.status}.`);
      }
      const data = await res.json();
      const result = Number(data?.rates?.[this.conversionTo]);
      if (!Number.isFinite(result)) {
        throw new Error('Exchange-rate service did not return the requested currency.');
      }

      if (requestId === this.conversionRequestId) {
        this.conversionResult = result;
        this.conversionRateDate = data.date;
        this.changeDetectorRef.markForCheck();
      }
    } catch (error) {
      if (requestId === this.conversionRequestId) {
        console.error('Currency conversion failed', error);
        this.conversionResult = null;
        this.conversionError = 'Could not fetch live exchange rates. Check your connection and try again.';
        this.changeDetectorRef.markForCheck();
      }
    }
  }

  convertCurrency() { this.autoConvertCurrency(); }

  toggleDarkMode() {
    this.darkMode = !this.darkMode;
    document.body.classList.toggle('dark', this.darkMode);
  }
  setInstitutionTheme(theme: string) { this.institutionTheme = theme; }

  getCategoryIcon(cat: string): string {
    const found = this.categories.find(c => c.name === cat);
    return found ? found.icon : 'pricetag-outline';
  }
  getCategoryColor(cat: string): string {
    const found = this.categories.find(c => c.name === cat);
    return found ? found.color : '#002d5b';
  }

  renderChart() {
    if (!this.expenseChartCanvas) return;
    const ctx = this.expenseChartCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    const catTotals: { [key: string]: number } = {};
    this.categories.forEach(c => catTotals[c.name] = 0);
    this.expenses.forEach(e => {
      if (catTotals[e.category] !== undefined) {
        catTotals[e.category] += Number(e.amount);
      }
    });

    if (this.chartInstance) this.chartInstance.destroy();

    this.chartInstance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: this.categories.map(c => c.name),
        datasets: [{
          data: this.categories.map(c => catTotals[c.name]),
          backgroundColor: this.categories.map(c => c.color),
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } }
      }
    });
  }

  private async showToast(message: string) {
    const toast = await this.toastController.create({ message, duration: 2500, position: 'bottom' });
    toast.present();
  }
}