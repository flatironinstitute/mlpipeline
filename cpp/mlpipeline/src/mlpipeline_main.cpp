/*
 * Copyright 2016-2017 Flatiron Institute, Simons Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
#include <QApplication>
#include <QFile>
#if QT_VERSION >= 0x050600
#include <QWebChannel>
#include <QWebEngineView>
#include <QWebEnginePage>
#include <QWebEngineSettings>
#else
#include <QWebInspector>
#include <QWebView>
#include <QWebFrame>
#include <QMessageBox>
#endif
#include <QHBoxLayout>
#include <QSplitter>
#include <QTabWidget>
#include <QCloseEvent>
#include <QMainWindow>
#include <QFileInfo>
#include <QJsonDocument>
#include "clparams.h"
#include "mlpinterface.h"

QString read_text_file(const QString& fname, QTextCodec* codec=0)
{
    QFile file(fname);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        return QString();
    }
    QTextStream ts(&file);
    if (codec != 0)
        ts.setCodec(codec);
    QString ret = ts.readAll();
    file.close();
    return ret;
}

#if QT_VERSION >= 0x050600
class MyPage : public QWebEnginePage {
#else
class MyPage : public QWebPage {
#endif
  public:
#if QT_VERSION >= 0x050600
    void javaScriptConsoleMessage(JavaScriptConsoleMessageLevel level, const QString & message, int lineNumber, const QString & sourceID) Q_DECL_OVERRIDE {
#else
    void javaScriptConsoleMessage(const QString & message, int lineNumber, const QString & sourceID) Q_DECL_OVERRIDE {
#endif
        qDebug().noquote() << QString("%1:%2: %3").arg(sourceID).arg(lineNumber).arg(message);
    }
};
#if QT_VERSION >= 0x050600
class MyMainWidget : public QMainWindow {
public:
    void closeEvent(QCloseEvent *evt) Q_DECL_OVERRIDE {
        bool val = false;
        if (!m_close && frame) {
            frame->runJavaScript("if (window.okay_to_close) { window.okay_to_close() } else true", [this,&val](QVariant r) {
                val = r.toBool();
                if (val) {
                    m_close = true;
                    close();
                }
            });
            evt->ignore();
        } else {
            QMainWindow::closeEvent(evt);
        }
    }
    QWebEnginePage *frame=0;
    bool m_close = false;
};
#else
class MyMainWidget : public QMainWindow {
public:
    void closeEvent(QCloseEvent *evt) Q_DECL_OVERRIDE {
        if (frame) {
            bool val = frame->evaluateJavaScript("if (window.okay_to_close) { window.okay_to_close() } else true").toBool();
            if (!val) {
                evt->ignore();
                return;
            }
        }
        QMainWindow::closeEvent(evt);
    }
    QWebFrame *frame=0;
};
#endif

int main(int argc, char *argv[]) {
    QApplication a(argc,argv);

    CLParams CLP(argc,argv);
    QString arg1=CLP.unnamed_parameters.value(0);

    QString mlp_path;
    if (arg1.endsWith(".mlp")) {
        mlp_path=arg1;
    }
    QString js_path;
    if (arg1.endsWith(".js")) {
        js_path=arg1;
    }
    QString mls_path;
    if (arg1.endsWith(".mls")) {
        mls_path=arg1;
    }
#if QT_VERSION >= 0x050600
    QWebEngineView *W=new QWebEngineView;
#else
    QWebView *W=new QWebView;
#endif
    W->setPage(new MyPage());
    //TODO: Witold: this is how I find the .js source. we'll need to think of a better way
    QString path=QString(MLP_DIR)+"/web/mlpipeline";
    if (!QFile::exists(path+"/index.html")) {
        //find it somewhere else...
    }
    //QString html=read_text_file(path+"/index.html");
    QString url="file:///"+path+"/index.html";
    //QObject::connect(W->page(),&QWebPage::downloadRequested,[=]( const QNetworkRequest &req ) { (void)req; QMessageBox::information(0,"Download not supported","File downloads are not supported when using Qt versions prior 5.6."); });
#if QT_VERSION >= 0x050600
    W->page()->settings()->setAttribute(QWebEngineSettings::LocalContentCanAccessRemoteUrls, true);
    W->page()->settings()->setAttribute(QWebEngineSettings::LocalContentCanAccessFileUrls, true);
    W->page()->settings()->setAttribute(QWebEngineSettings::JavascriptEnabled, true);
    W->page()->settings()->setAttribute(QWebEngineSettings::LocalStorageEnabled, true);
    if (W->page()->webChannel()) {
        delete W->page()->webChannel();
    }
    QWebChannel *ch = new QWebChannel(W->page());
    W->page()->setWebChannel(ch);
    ch->registerObject("mlpinterface", new MLPInterface(W->page()));
    MyMainWidget main_window;
    main_window.frame=W->page();
#else
    W->page()->settings()->setAttribute(QWebSettings::DeveloperExtrasEnabled, true);
    W->page()->settings()->setAttribute(QWebSettings::AcceleratedCompositingEnabled, true);
    W->page()->settings()->setAttribute(QWebSettings::LocalContentCanAccessRemoteUrls, true);
    W->page()->settings()->setAttribute(QWebSettings::LocalContentCanAccessFileUrls, true);
    W->page()->settings()->setAttribute(QWebSettings::JavascriptEnabled, true);
    W->page()->settings()->setAttribute(QWebSettings::LocalStorageEnabled, true);
    W->page()->settings()->setLocalStoragePath(QString(MLP_DIR)+"/local_storage"); //Witold: this needs to be fixed
    QWebFrame *frame=W->page()->mainFrame();
    frame->addToJavaScriptWindowObject("mlpinterface",new MLPInterface(frame));
    frame->evaluateJavaScript("window.mlpipeline_mode='local';");

    if (!mlp_path.isEmpty()) {
        QString str=read_text_file(mlp_path);
        frame->evaluateJavaScript(QString("window.mlp_file_content=atob('%1');").arg((QString)str.toUtf8().toBase64()));
        frame->evaluateJavaScript(QString("window.mlp_file_path='%1';").arg(mlp_path));
        frame->evaluateJavaScript(QString("window.mlp_file_name='%1';").arg(QFileInfo(mlp_path).fileName()));
    }
    else if (!js_path.isEmpty()) {
        QString str=read_text_file(js_path);
        frame->evaluateJavaScript(QString("window.js_file_content=atob('%1');").arg((QString)str.toUtf8().toBase64()));
        frame->evaluateJavaScript(QString("window.js_file_path='%1';").arg(js_path));
        frame->evaluateJavaScript(QString("window.js_file_name='%1';").arg(QFileInfo(js_path).fileName()));
    }
    else if (!mls_path.isEmpty()) {
        QString str=read_text_file(mls_path);
        frame->evaluateJavaScript(QString("window.mls_file_content=atob('%1');").arg((QString)str.toUtf8().toBase64()));
        frame->evaluateJavaScript(QString("window.mls_file_path='%1';").arg(mls_path));
        frame->evaluateJavaScript(QString("window.mls_file_name='%1';").arg(QFileInfo(mls_path).fileName()));
    }
    else {
        frame->evaluateJavaScript(QString("window.mlp_load_default_browser_storage=true;"));
    }

    QWebInspector *WI=new QWebInspector;
    WI->setPage(W->page());
    MyMainWidget main_window;
    main_window.frame=frame;
#endif
    //QHBoxLayout *main_layout=new QHBoxLayout;
    //main_window.setLayout(main_layout);
    QTabWidget *tab_widget=new QTabWidget;
    tab_widget->setTabPosition(QTabWidget::South);
    //main_layout->addWidget(tab_widget);
    main_window.setCentralWidget(tab_widget);
    tab_widget->addTab(W,"MLPipeline");
#if QT_VERSION >= 0x050600
#else
    tab_widget->addTab(WI,"Debug");
#endif
    W->load(url);
#if QT_VERSION >= 0x050600
    W->page()->runJavaScript("window.mlpipeline_mode='local';");
#endif
    W->setFocusPolicy(Qt::StrongFocus);

    main_window.setMinimumWidth(1200);
    main_window.setMinimumHeight(800);
    main_window.show();

    return a.exec();
}
