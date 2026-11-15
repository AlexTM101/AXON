using System.Windows;
namespace Axon.Desktop;
public partial class App : Application {
 protected override void OnStartup(StartupEventArgs e) { base.OnStartup(e); try { var options=LaunchOptions.Parse(e.Args); var window=new MainWindow(options); MainWindow=window; window.Show(); } catch { MessageBox.Show("Не удалось запустить AXON. Проверьте параметры запуска и доступ к папке настроек.","AXON",MessageBoxButton.OK,MessageBoxImage.Error); Shutdown(1); } }
}
