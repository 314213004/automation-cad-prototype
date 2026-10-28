// Qt 客户端壳子 v0.1 实现。注意：本文件只用 Qt Widgets + Network，
// 不含 OCCT 头文件；视口是占位 QWidget，OCCT AIS 接入是后续里程碑。
#include "MainWindow.h"

#include <QFormLayout>
#include <QHeaderView>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLabel>
#include <QMenuBar>
#include <QMessageBox>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QSplitter>
#include <QStatusBar>
#include <QTableWidget>
#include <QToolBar>
#include <QTreeWidget>
#include <QVBoxLayout>

namespace {
QJsonObject readReply(QNetworkReply *reply) {
    const QByteArray data = reply->readAll();
    QJsonDocument doc = QJsonDocument::fromJson(data);
    return doc.isObject() ? doc.object() : QJsonObject();
}
} // namespace

MainWindow::MainWindow(QWidget *parent)
    : QMainWindow(parent), m_net(new QNetworkAccessManager(this)) {
    setWindowTitle(tr("AutomationCAD · Qt 工作台（v0.1 壳子）"));
    resize(1280, 800);

    auto *fileMenu = menuBar()->addMenu(tr("文件"));
    fileMenu->addAction(tr("刷新特征树"), this, &MainWindow::loadTree);
    auto *viewMenu = menuBar()->addMenu(tr("视图"));
    viewMenu->addAction(tr("适合视图"), this, [] {});
    menuBar()->addMenu(tr("插入"));
    menuBar()->addMenu(tr("工具"));
    menuBar()->addMenu(tr("评估"));

    auto *toolbar = addToolBar(tr("特征工具栏"));
    toolbar->addAction(tr("拉伸凸台"), this, [] {});
    toolbar->addAction(tr("拉伸切除"), this, [] {});
    toolbar->addAction(tr("旋转"), this, [] {});
    toolbar->addAction(tr("圆角"), this, [] {});
    toolbar->addAction(tr("倒角"), this, [] {});
    toolbar->addAction(tr("基准面"), this, [] {});

    m_tree = new QTreeWidget(this);
    m_tree->setHeaderLabel(tr("FeatureManager 设计树"));
    m_tree->setColumnCount(1);

    m_viewportPlaceholder = new QLabel(tr("3D 视口占位\nOCCT AIS Viewer 接入中（后续里程碑）"), this);
    m_viewportPlaceholder->setAlignment(Qt::AlignCenter);
    m_viewportPlaceholder->setStyleSheet(QStringLiteral("background:#1c1f26;color:#9aa3b2;font-size:16px;"));

    m_panel = new QTableWidget(0, 2, this);
    m_panel->setHorizontalHeaderLabels({tr("参数"), tr("值")});
    m_panel->horizontalHeader()->setStretchLastSection(true);

    auto *right = new QWidget(this);
    auto *rightLayout = new QVBoxLayout(right);
    rightLayout->addWidget(new QLabel(tr("PropertyManager 属性面板"), right));
    rightLayout->addWidget(m_panel);
    right->setLayout(rightLayout);

    m_splitter = new QSplitter(this);
    m_splitter->addWidget(m_tree);
    m_splitter->addWidget(m_viewportPlaceholder);
    m_splitter->addWidget(right);
    m_splitter->setSizes({260, 720, 300});
    setCentralWidget(m_splitter);

    m_statusRevision = new QLabel(tr("未连接"), this);
    statusBar()->addPermanentWidget(m_statusRevision);
    statusBar()->showMessage(tr("单位：mm 优先"));

    connect(m_tree, &QTreeWidget::itemClicked, this, &MainWindow::onTreeItemSelected);
    connect(m_panel, &QTableWidget::cellChanged, this, &MainWindow::onPropertyCellChanged);
    loadTree();
}

void MainWindow::loadTree() {
    QNetworkRequest req(QUrl(m_serviceBase + QStringLiteral("/v1/tree")));
    QNetworkReply *reply = m_net->get(req);
    connect(reply, &QNetworkReply::finished, this, &MainWindow::onTreeReply);
}

void MainWindow::onTreeReply() {
    auto *reply = qobject_cast<QNetworkReply *>(sender());
    if (!reply) return;
    reply->deleteLater();
    if (reply->error() != QNetworkReply::NoError) {
        m_statusRevision->setText(tr("服务未连接：%1").arg(reply->errorString()));
        return;
    }
    refreshTree(readReply(reply));
}

void MainWindow::refreshTree(const QJsonObject &envelope) {
    m_envelope = envelope;
    const QJsonObject doc = envelope.value(QStringLiteral("doc")).toObject();
    const QJsonArray features = doc.value(QStringLiteral("features")).toArray();
    m_tree->clear();
    auto *part = new QTreeWidgetItem(m_tree, {tr("零件")});
    for (const auto &fv : features) {
        QJsonObject f = fv.toObject();
        auto *item = new QTreeWidgetItem(part, {f.value(QStringLiteral("name")).toString()});
        item->setData(0, Qt::UserRole, f.value(QStringLiteral("id")).toString());
        if (f.value(QStringLiteral("suppressed")).toBool()) item->setForeground(0, Qt::gray);
    }
    m_tree->expandAll();
    m_statusRevision->setText(tr("版本 r%1").arg(envelope.value(QStringLiteral("revision")).toInt()));
}

void MainWindow::onTreeItemSelected(QTreeWidgetItem *item, int) {
    if (!item) return;
    const QString id = item->data(0, Qt::UserRole).toString();
    if (id.isEmpty()) return;
    m_selectedFeatureId = id;
    const QJsonArray features = m_envelope.value(QStringLiteral("doc")).toObject().value(QStringLiteral("features")).toArray();
    for (const auto &fv : features) {
        QJsonObject f = fv.toObject();
        if (f.value(QStringLiteral("id")).toString() == id) { refreshPanel(f); return; }
    }
}

void MainWindow::refreshPanel(const QJsonObject &feature) {
    m_updatingPanel = true;
    const QJsonObject params = feature.value(QStringLiteral("params")).toObject();
    m_panel->setRowCount(0);
    int row = 0;
    for (auto it = params.begin(); it != params.end(); ++it) {
        if (it.value().isArray() || it.value().isObject()) continue; // 孔位数组等复杂值 v1 不在表格里直改
        m_panel->insertRow(row);
        m_panel->setItem(row, 0, new QTableWidgetItem(it.key()));
        QString v = it.value().isString() ? it.value().toString()
                    : it.value().isBool() ? (it.value().toBool() ? QStringLiteral("true") : QStringLiteral("false"))
                    : QString::number(it.value().toDouble());
        auto *valueItem = new QTableWidgetItem(v);
        valueItem->setData(Qt::UserRole, it.key());
        m_panel->setItem(row, 1, valueItem);
        ++row;
    }
    m_updatingPanel = false;
}

void MainWindow::onPropertyCellChanged(int row, int) {
    if (m_updatingPanel || m_selectedFeatureId.isEmpty()) return;
    QTableWidgetItem *keyItem = m_panel->item(row, 0);
    QTableWidgetItem *valueItem = m_panel->item(row, 1);
    if (!keyItem || !valueItem) return;
    bool ok = false;
    const double num = valueItem->text().toDouble(&ok);
    QJsonObject patch;
    patch.insert(keyItem->text(), ok ? QJsonValue(num) : QJsonValue(valueItem->text()));
    QJsonObject body;
    body.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
    body.insert(QStringLiteral("expectedRevision"), m_envelope.value(QStringLiteral("revision")).toInt());
    body.insert(QStringLiteral("actor"), QStringLiteral("manual"));
    body.insert(QStringLiteral("operation"), QStringLiteral("updateFeatureParams"));
    body.insert(QStringLiteral("featureId"), m_selectedFeatureId);
    body.insert(QStringLiteral("patch"), patch);
    postOperation(body);
}

void MainWindow::postOperation(const QJsonObject &body) {
    QNetworkRequest req(QUrl(m_serviceBase + QStringLiteral("/v1/operations")));
    req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    QNetworkReply *reply = m_net->post(req, QJsonDocument(body).toJson());
    connect(reply, &QNetworkReply::finished, this, &MainWindow::onOperationReply);
}

void MainWindow::onOperationReply() {
    auto *reply = qobject_cast<QNetworkReply *>(sender());
    if (!reply) return;
    reply->deleteLater();
    QJsonObject obj = readReply(reply);
    if (reply->error() == QNetworkReply::NoError) { refreshTree(obj); return; }
    if (obj.value(QStringLiteral("error")).toString() == QStringLiteral("CONFLICT_STALE_REVISION")) {
        showConflict(obj.value(QStringLiteral("current")).toObject());
        return;
    }
    QMessageBox::warning(this, tr("保存失败"),
        obj.value(QStringLiteral("message")).toString());
    loadTree(); // 失败后以服务端版本刷新，禁止在旧版本上继续编辑
}

void MainWindow::showConflict(const QJsonObject &current) {
    QMessageBox::warning(this, tr("版本冲突"),
        tr("你的版本已过期，服务端当前版本为 r%1。请重新读取后再改，不要直接覆盖。")
            .arg(current.value(QStringLiteral("revision")).toInt()));
    if (!current.isEmpty()) refreshTree(current);
    else loadTree();
}
